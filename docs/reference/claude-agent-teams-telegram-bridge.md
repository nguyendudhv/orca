# Telegram bridge for Claude Agent Teams

Mirrors one chosen Agent Teams pane's output into a Telegram chat, and relays plain-text
replies from that chat back into the pane as input. It runs alongside the normal Agent Teams
splits — it never replaces or backs a pane, only shadows one.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy its token.
2. Start a chat with the bot (or add it to a group) and get the chat ID — the simplest way is to
   send it a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and
   read `message.chat.id` from the response.
3. Export both as environment variables before launching:

   ```sh
   export TELEGRAM_BOT_TOKEN="123456:ABC-your-bot-token"
   export TELEGRAM_CHAT_ID="123456789"
   ```

4. Launch the team with the bridge flag:

   ```sh
   orca claude-teams --telegram-bridge
   ```

`--telegram-bridge` is stripped before `claude` sees argv — it's an Orca-only flag. If either env
var is missing or empty, the command fails fast with an error instead of starting without a
bridge.

## Using it

On connect, the bot sends a one-time message naming the team and the pane it's watching (the
leader pane, by default).

- `/panes` — lists every pane in the team (`leader`/`teammate`, marks the one currently watched).
- `/watch <paneId>` — switches which pane is mirrored. Re-baselines its tail so old scrollback
  isn't resent as "new" output.
- Any other message — sent to the currently watched pane as input (as if typed and Enter pressed).
- Messages from any chat ID other than `TELEGRAM_CHAT_ID` are silently ignored.

Output is polled every 2s and ANSI escape codes are stripped before sending. Long pane output is
split into chunks of up to 3500 characters, comfortably under Telegram's 4096-character message
limit.

## Lifecycle

The bridge starts when the team's leader launches and stops automatically when the team is
evicted — there's no separate shutdown step. Stopping cancels the in-flight Telegram long-poll
immediately rather than waiting it out.

## Constraints

- **One bot token per active bridge.** Telegram's `getUpdates` queue is global per token, with a
  single offset cursor. A second team started with the same `TELEGRAM_BOT_TOKEN` is refused (the
  bot replies in-chat explaining why) instead of racing the first team's poller. Use a separate
  bot per concurrently-bridged team.
- **One pane at a time per team**, switchable with `/watch` — there's no simultaneous
  multi-pane mirroring.
- Auth/connectivity failures (bad token, network errors) are logged to the console and retried
  with backoff; they aren't surfaced into the chat itself, since the chat is unreachable in
  exactly that failure case.
