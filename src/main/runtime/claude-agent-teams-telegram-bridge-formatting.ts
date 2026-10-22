/* eslint-disable no-control-regex -- ANSI escape sequences are raw PTY output. */
// Matches CSI, OSC, charset-designation, and other Fe escape sequences so mirrored output reads as plain text.
const ANSI_ESCAPE_PATTERN =
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[()][0-9A-Za-z]|\x1B[@-Z\\^_]/g

export function stripAnsiEscapeCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}

/**
 * A pane's scrollback tail is re-read in full on every poll (the terminal API has no cursor), so this
 * finds the longest suffix of `previous` that reappears as a prefix of `next` and returns only what
 * follows it — the lines actually new since the last poll.
 */
export function diffNewTailLines(previous: string[], next: string[]): string[] {
  if (previous.length === 0) {
    return next
  }
  const maxOverlap = Math.min(previous.length, next.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    let matches = true
    for (let i = 0; i < overlap; i++) {
      if (previous[previous.length - overlap + i] !== next[i]) {
        matches = false
        break
      }
    }
    if (matches) {
      return next.slice(overlap)
    }
  }
  return next
}

const TELEGRAM_MESSAGE_MAX_LENGTH = 3500

export function chunkTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_MAX_LENGTH) {
    return [text]
  }
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += TELEGRAM_MESSAGE_MAX_LENGTH) {
    chunks.push(text.slice(offset, offset + TELEGRAM_MESSAGE_MAX_LENGTH))
  }
  return chunks
}
