import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTelegramUpdates, sendTelegramMessage } from './claude-agent-teams-telegram-client'

function jsonResponse(body: unknown, status = 200): Response {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client only reads ok, status and json() from the fetch Response.
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

describe('claude-agent-teams-telegram-client', () => {
  const fetchMock = vi.fn()
  const credentials = { token: 'secret-token-123', chatId: '42' }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sendTelegramMessage', () => {
    it('posts to the bot token sendMessage endpoint with the chat id and text', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: {} }))

      await sendTelegramMessage(credentials, 'hello teammate')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`https://api.telegram.org/bot${credentials.token}/sendMessage`)
      expect(JSON.parse(init.body)).toEqual({ chat_id: '42', text: 'hello teammate' })
    })

    it('throws without leaking the bot token when Telegram rejects the request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, description: 'Unauthorized' }, 401))

      await expect(sendTelegramMessage(credentials, 'hi')).rejects.toThrow(/status 401/)
      await expect(sendTelegramMessage(credentials, 'hi')).rejects.not.toThrow(
        new RegExp(credentials.token)
      )
    })
  })

  describe('fetchTelegramUpdates', () => {
    it('requests getUpdates with the given offset and a server-side long-poll timeout', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: [{ update_id: 7, message: { text: '/panes', chat: { id: 42 } } }]
        })
      )

      const updates = await fetchTelegramUpdates(credentials, 99)

      expect(updates).toEqual([{ update_id: 7, message: { text: '/panes', chat: { id: 42 } } }])
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`https://api.telegram.org/bot${credentials.token}/getUpdates`)
      const body = JSON.parse(init.body)
      expect(body.offset).toBe(99)
      expect(body.timeout).toBeGreaterThan(0)
    })

    it('returns an empty array when Telegram answers with no updates', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }))

      await expect(fetchTelegramUpdates(credentials, 0)).resolves.toEqual([])
    })
  })
})
