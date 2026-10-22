import type { AgentTeam, AgentTeamsTerminalApi } from './claude-agent-teams-types'
import {
  chunkTelegramMessage,
  diffNewTailLines,
  stripAnsiEscapeCodes
} from './claude-agent-teams-telegram-bridge-formatting'
import {
  fetchTelegramUpdates,
  sendTelegramMessage,
  type ClaudeAgentTeamsTelegramCredentials,
  type TelegramUpdate
} from './claude-agent-teams-telegram-client'

type BridgeState = {
  team: AgentTeam
  api: AgentTeamsTerminalApi
  credentials: ClaudeAgentTeamsTelegramCredentials
  watchedPaneId: string
  lastTailByPane: Map<string, string[]>
  updateOffset: number
  stopped: boolean
  outputPollTimer: ReturnType<typeof setTimeout> | null
  outputPollErrorLogged: boolean
  updatePollErrorLogged: boolean
  // Why: cancels the in-flight getUpdates long-poll the instant stop() runs, instead of
  // leaving the update loop blocked on the client's own ~35s internal abort.
  updateAbort: AbortController
}

export const OUTPUT_POLL_INTERVAL_MS = 2000
export const OUTPUT_POLL_ERROR_RETRY_MS = 15_000
export const UPDATE_POLL_ERROR_RETRY_MS = 5_000
const TERMINAL_READ_LIMIT = 200

/**
 * Mirrors one team's chosen pane into a Telegram chat and relays replies back as pane input.
 * Runs alongside the normal tmux-compat pane mechanism; never owns or replaces it.
 */
export class ClaudeAgentTeamsTelegramBridge {
  private readonly bridges = new Map<string, BridgeState>()
  // Why: Telegram's getUpdates queue is global per bot token, with one offset cursor. Two bridges
  // long-polling the same token would race and silently drop each other's updates, and a reply
  // couldn't be attributed to either team's pane anyway.
  private readonly activeTokens = new Set<string>()

  start(
    team: AgentTeam,
    api: AgentTeamsTerminalApi,
    credentials: ClaudeAgentTeamsTelegramCredentials
  ): void {
    if (this.bridges.has(team.teamId)) {
      return
    }
    if (this.activeTokens.has(credentials.token)) {
      console.error(
        `[claude-agent-teams-telegram-bridge] refusing to start: bot token already bridged to another team (team ${team.teamId})`
      )
      void sendTelegramMessage(
        credentials,
        `Team ${team.teamId} was not bridged: this bot token is already bridged to another team. Stop that team first, or use a separate bot token.`
      ).catch((error) => {
        console.error(
          '[claude-agent-teams-telegram-bridge] failed to send telegram message:',
          describeError(error)
        )
      })
      return
    }
    this.activeTokens.add(credentials.token)
    const state: BridgeState = {
      team,
      api,
      credentials,
      watchedPaneId: team.leaderPane,
      lastTailByPane: new Map(),
      updateOffset: 0,
      stopped: false,
      outputPollTimer: null,
      outputPollErrorLogged: false,
      updatePollErrorLogged: false,
      updateAbort: new AbortController()
    }
    this.bridges.set(team.teamId, state)
    this.scheduleOutputPoll(state)
    void this.pollUpdatesLoop(state)
    void this.sendBridgeMessage(
      state,
      `Orca agent team ${team.teamId} connected. Watching leader pane ${state.watchedPaneId}.\n/panes to list panes, /watch <paneId> to switch.`
    )
  }

  stop(teamId: string): void {
    const state = this.bridges.get(teamId)
    if (!state) {
      return
    }
    state.stopped = true
    if (state.outputPollTimer) {
      clearTimeout(state.outputPollTimer)
    }
    state.updateAbort.abort()
    this.activeTokens.delete(state.credentials.token)
    this.bridges.delete(teamId)
  }

  private scheduleOutputPoll(state: BridgeState, delayMs: number = OUTPUT_POLL_INTERVAL_MS): void {
    if (state.stopped) {
      return
    }
    state.outputPollTimer = setTimeout(() => {
      void this.pollOutputOnce(state).then((ok) =>
        this.scheduleOutputPoll(state, ok ? OUTPUT_POLL_INTERVAL_MS : OUTPUT_POLL_ERROR_RETRY_MS)
      )
    }, delayMs)
  }

  private async pollOutputOnce(state: BridgeState): Promise<boolean> {
    const pane = state.team.panes.get(state.watchedPaneId)
    if (!pane) {
      return true
    }
    try {
      const read = await state.api.readTerminal(pane.handle, { limit: TERMINAL_READ_LIMIT })
      const previous = state.lastTailByPane.get(state.watchedPaneId) ?? []
      state.lastTailByPane.set(state.watchedPaneId, read.tail)
      state.outputPollErrorLogged = false
      const delta = stripAnsiEscapeCodes(diffNewTailLines(previous, read.tail).join('\n')).trim()
      if (delta) {
        await this.sendBridgeMessage(state, delta)
      }
      return true
    } catch (error) {
      if (!state.outputPollErrorLogged) {
        state.outputPollErrorLogged = true
        console.error(
          '[claude-agent-teams-telegram-bridge] failed reading pane output:',
          describeError(error)
        )
      }
      return false
    }
  }

  private async pollUpdatesLoop(state: BridgeState): Promise<void> {
    while (!state.stopped) {
      try {
        const updates = await fetchTelegramUpdates(
          state.credentials,
          state.updateOffset,
          state.updateAbort.signal
        )
        state.updatePollErrorLogged = false
        for (const update of updates) {
          if (state.stopped) {
            break
          }
          state.updateOffset = update.update_id + 1
          await this.handleTelegramUpdate(state, update)
        }
      } catch (error) {
        // Why: stop() aborts the in-flight fetch on purpose; that is not a polling failure.
        if (state.stopped) {
          return
        }
        if (!state.updatePollErrorLogged) {
          state.updatePollErrorLogged = true
          console.error(
            '[claude-agent-teams-telegram-bridge] failed polling telegram updates:',
            describeError(error)
          )
        }
        await delay(UPDATE_POLL_ERROR_RETRY_MS)
      }
    }
  }

  private async handleTelegramUpdate(state: BridgeState, update: TelegramUpdate): Promise<void> {
    const text = update.message?.text?.trim()
    const chatId = update.message?.chat?.id
    if (!text || chatId === undefined || String(chatId) !== state.credentials.chatId) {
      return
    }
    if (text.startsWith('/')) {
      await this.handleCommand(state, text)
      return
    }
    await this.relayInputToWatchedPane(state, text)
  }

  private async handleCommand(state: BridgeState, text: string): Promise<void> {
    const [command, ...rest] = text.split(/\s+/)
    if (command === '/panes') {
      await this.sendBridgeMessage(state, this.describePanes(state))
      return
    }
    if (command === '/watch') {
      await this.handleWatchCommand(state, rest[0])
      return
    }
    await this.sendBridgeMessage(state, `Unknown command: ${command}`)
  }

  private describePanes(state: BridgeState): string {
    if (state.team.paneOrder.length === 0) {
      return 'No panes.'
    }
    return state.team.paneOrder
      .map((paneId) => {
        const role = paneId === state.team.leaderPane ? 'leader' : 'teammate'
        const marker = paneId === state.watchedPaneId ? ' (watching)' : ''
        return `${paneId} - ${role}${marker}`
      })
      .join('\n')
  }

  private async handleWatchCommand(
    state: BridgeState,
    targetPaneId: string | undefined
  ): Promise<void> {
    if (!targetPaneId) {
      await this.sendBridgeMessage(state, 'Usage: /watch <paneId> (see /panes)')
      return
    }
    const pane = state.team.panes.get(targetPaneId)
    if (!pane) {
      await this.sendBridgeMessage(state, `Unknown pane: ${targetPaneId}`)
      return
    }
    state.watchedPaneId = targetPaneId
    try {
      const read = await state.api.readTerminal(pane.handle, { limit: TERMINAL_READ_LIMIT })
      // Why: seed the baseline so switching panes doesn't dump the whole scrollback.
      state.lastTailByPane.set(targetPaneId, read.tail)
    } catch {
      state.lastTailByPane.delete(targetPaneId)
    }
    await this.sendBridgeMessage(state, `Now watching pane ${targetPaneId}.`)
  }

  private async relayInputToWatchedPane(state: BridgeState, text: string): Promise<void> {
    const pane = state.team.panes.get(state.watchedPaneId)
    if (!pane) {
      await this.sendBridgeMessage(
        state,
        `Watched pane ${state.watchedPaneId} is gone. Use /panes then /watch.`
      )
      return
    }
    try {
      const result = await state.api.sendTerminal(
        pane.handle,
        { text, enter: true },
        { inputKind: 'driving' }
      )
      if (!result.accepted) {
        await this.sendBridgeMessage(
          state,
          `Pane did not accept input${result.refusedReason ? ` (${result.refusedReason})` : ''}.`
        )
      }
    } catch (error) {
      console.error(
        '[claude-agent-teams-telegram-bridge] failed to relay input to pane:',
        describeError(error)
      )
      await this.sendBridgeMessage(state, 'Failed to send input to the pane.')
    }
  }

  private async sendBridgeMessage(state: BridgeState, text: string): Promise<void> {
    for (const chunk of chunkTelegramMessage(text)) {
      try {
        await sendTelegramMessage(state.credentials, chunk)
      } catch (error) {
        console.error(
          '[claude-agent-teams-telegram-bridge] failed to send telegram message:',
          describeError(error)
        )
        return
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
