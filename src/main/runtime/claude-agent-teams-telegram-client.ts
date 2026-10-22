export type ClaudeAgentTeamsTelegramCredentials = {
  token: string
  chatId: string
}

export type TelegramUpdate = {
  update_id: number
  message?: {
    text?: string
    chat?: { id: number | string }
  }
}

type TelegramApiPayload = {
  ok?: boolean
  result?: unknown
  description?: string
}

// Why: the token lives only in the URL path; every thrown message here stays token-free on purpose.
function telegramApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`
}

async function parseTelegramResponse(response: Response): Promise<TelegramApiPayload> {
  let payload: TelegramApiPayload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Telegram API returned a non-JSON response (status ${response.status})`)
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(
      `Telegram API request failed (status ${response.status}): ${payload.description ?? 'unknown error'}`
    )
  }
  return payload
}

export async function sendTelegramMessage(
  credentials: ClaudeAgentTeamsTelegramCredentials,
  text: string
): Promise<void> {
  const response = await fetch(telegramApiUrl(credentials.token, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: credentials.chatId, text })
  })
  await parseTelegramResponse(response)
}

const GET_UPDATES_TIMEOUT_SECONDS = 25
// Why: the long-poll itself blocks server-side for GET_UPDATES_TIMEOUT_SECONDS; give the client call
// enough slack past that before giving up, instead of racing Telegram's own timeout.
const GET_UPDATES_ABORT_MS = (GET_UPDATES_TIMEOUT_SECONDS + 10) * 1000

export async function fetchTelegramUpdates(
  credentials: ClaudeAgentTeamsTelegramCredentials,
  offset: number,
  externalSignal?: AbortSignal
): Promise<TelegramUpdate[]> {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), GET_UPDATES_ABORT_MS)
  // Why: lets a caller (bridge shutdown) cancel the in-flight long-poll immediately instead of
  // waiting out the full GET_UPDATES_ABORT_MS slack.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal
  try {
    const response = await fetch(telegramApiUrl(credentials.token, 'getUpdates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: GET_UPDATES_TIMEOUT_SECONDS,
        allowed_updates: ['message']
      }),
      signal
    })
    const payload = await parseTelegramResponse(response)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Telegram's getUpdates contract guarantees result entries match TelegramUpdate.
    return Array.isArray(payload.result) ? (payload.result as TelegramUpdate[]) : []
  } finally {
    clearTimeout(abortTimer)
  }
}
