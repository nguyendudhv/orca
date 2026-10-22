import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

// The claude-teams handler spawns `claude` via node:child_process; mock it so we
// can inspect the child env without launching a real process.
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Keep the socket runtime client out of the import graph; only the error type
// and serveOrcaApp binding are referenced by the module under test.
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  serveOrcaApp: vi.fn()
}))

import { CORE_HANDLERS } from './core'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

type SpawnEnv = Record<string, string | undefined>

// Minimal child stub: the handler only awaits `exit`, so resolve it on the next
// microtask to complete the spawned-process promise deterministically.
function mockClaudeChild(): { once: (event: string, cb: (...args: unknown[]) => void) => unknown } {
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        queueMicrotask(() => cb(0, null))
      }
      return child
    }
  }
  return child
}

describe('orca claude-teams CLI handler', () => {
  const isWindows = process.platform === 'win32'
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode
  let previousBotToken: string | undefined
  let previousChatId: string | undefined

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  function runClaudeTeams(rawArgs: string[] = []): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs
    }
    return CORE_HANDLERS['claude-teams'](ctx)
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' } }
      }
    })
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    previousPaneKey = process.env.ORCA_PANE_KEY
    previousExitCode = process.exitCode
    previousBotToken = process.env.TELEGRAM_BOT_TOKEN
    previousChatId = process.env.TELEGRAM_CHAT_ID
    // The `orca` launcher runs Orca's Electron binary as Node, so the CLI process
    // itself carries ELECTRON_RUN_AS_NODE=1. Reproduce that inherited flag here.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
  })

  afterEach(() => {
    if (previousRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
    }
    if (previousPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = previousPaneKey
    }
    if (previousBotToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousBotToken
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId
    }
    process.exitCode = previousExitCode
  })

  // Guarded to non-Windows: the handler early-returns unsupported_platform on
  // win32, so the leak path never runs there.
  it.skipIf(isWindows)(
    'does not leak ELECTRON_RUN_AS_NODE into the spawned claude child',
    async () => {
      await runClaudeTeams()

      expect(spawnMock).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object))
      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()

      // The prepareLaunch request env is built from the same helper, so it must
      // be sanitized too.
      const prepareLaunchEnv = (callMock.mock.calls[0][1] as { env: SpawnEnv }).env
      expect(prepareLaunchEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  )

  it.skipIf(isWindows)(
    'still forwards non-Electron parent env and prepareLaunch env to claude',
    async () => {
      const previousMarker = process.env.ORCA_TEST_MARKER
      process.env.ORCA_TEST_MARKER = 'keep-me'
      try {
        await runClaudeTeams()
      } finally {
        if (previousMarker === undefined) {
          delete process.env.ORCA_TEST_MARKER
        } else {
          process.env.ORCA_TEST_MARKER = previousMarker
        }
      }

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ORCA_TEST_MARKER).toBe('keep-me')
      expect(spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
      expect(spawnEnv.PATH).toBe('/shim:/usr/bin')
    }
  )

  it.skipIf(isWindows)('removes managed auth variables before spawning Claude', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
    callMock.mockResolvedValueOnce({
      result: {
        launch: {
          env: {
            CLAUDE_CONFIG_DIR: '/managed/claude',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
          },
          envToDelete: ['ANTHROPIC_API_KEY']
        }
      }
    })
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe('/managed/claude')
  })

  it.skipIf(isWindows)('preserves API-key auth when no managed deletion is requested', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system'
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-system')
  })

  it.skipIf(isWindows)(
    'sends telegram bridge credentials and strips --telegram-bridge before spawning claude',
    async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bot-token-123'
      process.env.TELEGRAM_CHAT_ID = '555'

      await runClaudeTeams(['--telegram-bridge', '--resume', 'abc'])

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked client.call only ever receives the prepareLaunch params this handler builds.
      const prepareLaunchParams = callMock.mock.calls[0][1] as {
        telegramBridge?: { token: string; chatId: string }
      }
      expect(prepareLaunchParams.telegramBridge).toEqual({ token: 'bot-token-123', chatId: '555' })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawnMock is only ever called with the claude argv array built by this handler.
      const claudeArgs = spawnMock.mock.calls.at(-1)?.[1] as string[]
      expect(claudeArgs).not.toContain('--telegram-bridge')
      expect(claudeArgs).toEqual(expect.arrayContaining(['--resume', 'abc']))
    }
  )

  it.skipIf(isWindows)(
    'fails fast without spawning claude when telegram env vars are missing',
    async () => {
      await expect(runClaudeTeams(['--telegram-bridge'])).rejects.toThrow(
        /TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/
      )

      expect(spawnMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it.skipIf(isWindows)(
    'omits telegramBridge from the RPC call when the flag is absent',
    async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bot-token-123'
      process.env.TELEGRAM_CHAT_ID = '555'

      await runClaudeTeams()

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked client.call only ever receives the prepareLaunch params this handler builds.
      const prepareLaunchParams = callMock.mock.calls[0][1] as Record<string, unknown>
      expect(prepareLaunchParams.telegramBridge).toBeUndefined()
    }
  )
})
