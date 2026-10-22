import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeAgentTeamsTelegramBridge,
  OUTPUT_POLL_INTERVAL_MS,
  UPDATE_POLL_ERROR_RETRY_MS
} from './claude-agent-teams-telegram-bridge'
import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

const CREDENTIALS = { token: 'secret-token', chatId: '42' }

function createTeam(): AgentTeam {
  const leaderPane: TeamPane = { fakePaneId: '%1', handle: 'leader-handle', index: 0 }
  const teammatePane: TeamPane = { fakePaneId: '%2', handle: 'teammate-handle', index: 1 }
  return {
    teamId: 'team-1',
    token: 'team-token',
    leaderPane: '%1',
    leaderHandle: 'leader-handle',
    sessionName: 'orca',
    windowIndex: '0',
    tmuxValue: '/tmp/orca-claude-agent-teams/team-1,0,1',
    baseEnv: {},
    panes: new Map([
      ['%1', leaderPane],
      ['%2', teammatePane]
    ]),
    paneOrder: ['%1', '%2'],
    nextPaneNumber: 3,
    mainVertical: null,
    previouslyFocusedPane: null
  }
}

function createFakeApi(): AgentTeamsTerminalApi {
  const emptyTail: string[] = []
  return {
    splitTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', paneRuntimeId: -1 })),
    readTerminal: vi.fn(async (handle) => ({
      handle,
      status: 'running' as const,
      tail: emptyTail,
      truncated: false,
      nextCursor: null
    })),
    sendTerminal: vi.fn(async (handle, action) => ({
      handle,
      accepted: true,
      bytesWritten: action.text?.length ?? 0
    })),
    focusTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', worktreeId: 'wt-1' })),
    closeTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', ptyKilled: true })),
    showTerminal: vi.fn(async (handle) => ({
      handle,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      ptyId: 'pty-1',
      rendererGraphEpoch: 1
    }))
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge only reads ok, status and json() from the fetch Response.
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

type TelegramUpdate = { update_id: number; message?: { text?: string; chat?: { id: number } } }

/** Models Telegram's long-poll: a `getUpdates` call hangs until a batch is delivered. */
function createTelegramFetchStub(): {
  fetchMock: ReturnType<typeof vi.fn>
  sendMessageCalls: { text: string }[]
  deliverGetUpdates: (updates: TelegramUpdate[]) => void
  failGetUpdates: (description: string) => void
} {
  const sendMessageCalls: { text: string }[] = []
  const waitingGetUpdates: ((value: Response | PromiseLike<Response>) => void)[] = []
  const queuedGetUpdates: (Response | (() => Response))[] = []

  function deliverGetUpdates(updates: TelegramUpdate[]): void {
    const response = jsonResponse({ ok: true, result: updates })
    const resolver = waitingGetUpdates.shift()
    if (resolver) {
      resolver(response)
    } else {
      queuedGetUpdates.push(response)
    }
  }

  function failGetUpdates(description: string): void {
    const response = jsonResponse({ ok: false, description }, 401)
    const resolver = waitingGetUpdates.shift()
    if (resolver) {
      resolver(response)
    } else {
      queuedGetUpdates.push(response)
    }
  }

  const fetchMock = vi.fn((url: string, init: { body: string }) => {
    if (url.includes('/sendMessage')) {
      sendMessageCalls.push(JSON.parse(init.body))
      return Promise.resolve(jsonResponse({ ok: true, result: {} }))
    }
    if (url.includes('/getUpdates')) {
      const queued = queuedGetUpdates.shift()
      if (queued) {
        return Promise.resolve(typeof queued === 'function' ? queued() : queued)
      }
      return new Promise<Response>((resolve) => waitingGetUpdates.push(resolve))
    }
    return Promise.reject(new Error(`unexpected fetch url: ${url}`))
  })

  return { fetchMock, sendMessageCalls, deliverGetUpdates, failGetUpdates }
}

async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

describe('ClaudeAgentTeamsTelegramBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('mirrors new pane output into telegram, stripped of ANSI codes', async () => {
    const { fetchMock, sendMessageCalls } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const team = createTeam()
    const api = createFakeApi()
    vi.mocked(api.readTerminal).mockResolvedValue({
      handle: 'leader-handle',
      status: 'running',
      tail: ['\x1B[32mhello\x1B[0m', 'world'],
      truncated: false,
      nextCursor: null
    })
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()
    sendMessageCalls.length = 0

    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS)

    expect(api.readTerminal).toHaveBeenCalledWith('leader-handle', { limit: 200 })
    expect(sendMessageCalls.map((call) => call.text)).toContain('hello\nworld')
  })

  it('serves /panes, /watch, and relays plain text as pane input', async () => {
    const { fetchMock, sendMessageCalls, deliverGetUpdates } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const team = createTeam()
    const api = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()

    deliverGetUpdates([{ update_id: 1, message: { text: '/panes', chat: { id: 42 } } }])
    await flushAsync()
    expect(sendMessageCalls.at(-1)?.text).toBe('%1 - leader (watching)\n%2 - teammate')

    deliverGetUpdates([{ update_id: 2, message: { text: '/watch %2', chat: { id: 42 } } }])
    await flushAsync()
    expect(api.readTerminal).toHaveBeenCalledWith('teammate-handle', { limit: 200 })
    expect(sendMessageCalls.at(-1)?.text).toBe('Now watching pane %2.')

    deliverGetUpdates([{ update_id: 3, message: { text: 'go build it', chat: { id: 42 } } }])
    await flushAsync()
    expect(api.sendTerminal).toHaveBeenCalledWith(
      'teammate-handle',
      { text: 'go build it', enter: true },
      { inputKind: 'driving' }
    )
  })

  it('ignores messages from chats other than the configured chat id', async () => {
    const { fetchMock, sendMessageCalls, deliverGetUpdates } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const team = createTeam()
    const api = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()
    sendMessageCalls.length = 0

    deliverGetUpdates([{ update_id: 1, message: { text: 'hello', chat: { id: 999 } } }])
    await flushAsync()

    expect(api.sendTerminal).not.toHaveBeenCalled()
    expect(sendMessageCalls).toHaveLength(0)
  })

  it('stops polling output and updates once stopped', async () => {
    const { fetchMock } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const team = createTeam()
    const api = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()
    const readCallsBeforeStop = vi.mocked(api.readTerminal).mock.calls.length
    const fetchCallsBeforeStop = fetchMock.mock.calls.length

    bridge.stop(team.teamId)
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS * 3)

    expect(vi.mocked(api.readTerminal).mock.calls.length).toBe(readCallsBeforeStop)
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBeforeStop)
  })

  it('aborts the in-flight telegram long-poll immediately on stop(), without logging an error', async () => {
    const { fetchMock } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const team = createTeam()
    const api = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()

    const getUpdatesCall = fetchMock.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('/getUpdates')
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub's getUpdates init always carries the signal fetchTelegramUpdates built.
    const signal = (getUpdatesCall?.[1] as { signal?: AbortSignal } | undefined)?.signal
    expect(signal?.aborted).toBe(false)

    bridge.stop(team.teamId)
    await flushAsync()

    expect(signal?.aborted).toBe(true)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('refuses a second bridge on a bot token already bridged to another team', async () => {
    const { fetchMock, sendMessageCalls } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const teamA = createTeam()
    const teamB = { ...createTeam(), teamId: 'team-2' }
    const apiA = createFakeApi()
    const apiB = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(teamA, apiA, CREDENTIALS)
    await flushAsync()
    const getUpdatesCallsBeforeTeamB = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/getUpdates')
    ).length

    bridge.start(teamB, apiB, CREDENTIALS)
    await flushAsync()

    expect(sendMessageCalls.at(-1)?.text).toContain('team-2')
    expect(consoleErrorSpy).toHaveBeenCalled()
    expect(apiB.readTerminal).not.toHaveBeenCalled()
    const getUpdatesCallsAfterTeamB = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/getUpdates')
    ).length
    expect(getUpdatesCallsAfterTeamB).toBe(getUpdatesCallsBeforeTeamB)

    consoleErrorSpy.mockRestore()
  })

  it('logs an update-poll failure once and retries on backoff instead of looping tightly', async () => {
    const { fetchMock, failGetUpdates } = createTelegramFetchStub()
    vi.stubGlobal('fetch', fetchMock)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const team = createTeam()
    const api = createFakeApi()
    const bridge = new ClaudeAgentTeamsTelegramBridge()

    bridge.start(team, api, CREDENTIALS)
    await flushAsync()

    failGetUpdates('Unauthorized')
    await flushAsync()
    const getUpdatesCallCount = () =>
      fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/getUpdates'))
        .length

    expect(getUpdatesCallCount()).toBe(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_ERROR_RETRY_MS)
    failGetUpdates('Unauthorized')
    await flushAsync()

    expect(getUpdatesCallCount()).toBe(2)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0].join(' ')).not.toContain(CREDENTIALS.token)

    consoleErrorSpy.mockRestore()
  })
})
