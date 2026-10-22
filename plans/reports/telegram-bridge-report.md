# Telegram bridge for Claude Agent Teams — report

## What was built

A bridge/mirror service that runs alongside Orca's existing Agent Teams panes (does NOT replace or
back any pane). It mirrors a chosen team pane's terminal output into a Telegram chat, strips ANSI,
and relays plain-text replies from that chat back into the pane as driving input. Activated via a
new `orca claude-teams --telegram-bridge` flag; credentials come from `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` env vars, validated fail-fast in the CLI handler.

## Files touched/added

New:

- `src/main/runtime/claude-agent-teams-telegram-bridge-formatting.ts` (+test) — `stripAnsiEscapeCodes`,
  `diffNewTailLines` (scrollback-tail diffing via longest-suffix-is-prefix overlap), `chunkTelegramMessage`
  (3500-char chunks, under Telegram's 4096 cap).
- `src/main/runtime/claude-agent-teams-telegram-client.ts` (+test) — thin Telegram Bot API client:
  `sendTelegramMessage`, `fetchTelegramUpdates` (long-poll, 25s server timeout / 35s abort). Uses only
  built-in `fetch`, no new npm dep. Token only ever appears in the URL string (`telegramApiUrl` helper),
  never logged or put in thrown messages.
- `src/main/runtime/claude-agent-teams-telegram-bridge.ts` (+test) — `ClaudeAgentTeamsTelegramBridge`
  class, `Map<teamId, BridgeState>` internal state (no bolt-on fields on `AgentTeam`/`TeamPane`).
  `start(team, api, credentials)` / `stop(teamId)`. Polls watched pane every 2s (`OUTPUT_POLL_INTERVAL_MS`),
  backs off to 15s on read failure (`OUTPUT_POLL_ERROR_RETRY_MS`); long-polls Telegram updates in a loop,
  backs off 5s on failure (`UPDATE_POLL_ERROR_RETRY_MS`). Both error paths log once (boolean flag reset
  on next success) to avoid a tight error-spam loop.

Edited:

- `src/main/runtime/claude-agent-teams-service.ts` (+test) — added `getTeam(teamId)` and
  `setTeamRemovedListener(fn)`; `removeTeamForLeaderHandle` now fires the listener on eviction. This is
  the hook the bridge's teardown rides on.
- `src/main/runtime/construction/runtime-host-services.ts` — new field
  `claudeAgentTeamsTelegramBridge = new ClaudeAgentTeamsTelegramBridge()`, declared before `claudeAgentTeams`
  (ordering matters: the latter's initializer wires the listener via a free function
  `createClaudeAgentTeamsServiceWithTelegramBridge`, avoiding a constructor override that would need
  updating `runtime-composition-parity.test.ts`).
- `src/main/runtime/terminal/launch/terminal-split-source-authority.ts` — new
  `buildAgentTeamsTerminalApi()` helper (reused by both the tmux-compat handler and the bridge);
  `prepareClaudeAgentTeamsLeader`/`...ForHandle` take optional `telegramBridge?: {token, chatId}` and
  call `claudeAgentTeamsTelegramBridge.start(team, api, telegramBridge)` after launch when supplied.
  No explicit stop call needed here — it rides the `setTeamRemovedListener` hook instead.
- `src/shared/rpc-contract/terminal-unary-params.ts` — `AgentTeamsPrepareLaunch` gained optional
  `telegramBridge: { token, chatId }` field (zod). Chose to extend this existing RPC method rather than
  add a new one — no RPC-registration-file changes needed.
- `src/main/runtime/rpc/methods/terminal/terminal-lifecycle-methods.ts` — passes `params.telegramBridge`
  through to the prepare call.
- `src/cli/handlers/core.ts` (+test) — `requestsTelegramBridge` strips `--telegram-bridge` from argv
  before it reaches `claude` (unlike `--teammate-mode`, which claude understands);
  `resolveTelegramBridgeCredentials` reads+validates the two env vars, throws `RuntimeClientError` if
  either is missing/empty; `telegramBridge` is included in the `agentTeams.prepareLaunch` RPC params
  only when the flag was passed.
- `src/cli/specs/core.ts` — `claude-teams` spec notes/examples/usage documents `--telegram-bridge`.

## Telegram command surface

- `/panes` — lists all team panes (`leader`/`teammate`, marks the currently watched one).
- `/watch <paneId>` — switches the mirrored pane; re-baselines its tail so old scrollback isn't
  re-sent as "new".
- Any other non-slash text — relayed as input to the currently watched pane via
  `sendTerminal(handle, {text, enter: true}, {inputKind: 'driving'})`.
- Messages from any chat ID other than the configured `TELEGRAM_CHAT_ID` are silently ignored.
- On bridge start, sends a one-time "connected, watching leader pane X" message.

## Bridge lifecycle vs team lifecycle

Bridge start is opt-in and wired into `prepareClaudeAgentTeamsLeaderForHandle` right after the team
launch is prepared, keyed by `teamId`. Teardown is NOT scattered across every teardown call site —
`ClaudeAgentTeamsService.setTeamRemovedListener` is set once in `runtime-host-services.ts` to call
`bridge.stop(team.teamId)`, so wherever a team is evicted (`removeTeamForLeaderHandle`), the bridge
stops automatically. `stop()` clears the output-poll timer and flips a `stopped` flag the update
long-poll loop checks each iteration.

## Verification performed

- `pnpm tc:node` → "No type errors in 17,286 files".
- `pnpm test <5 touched/added test files>` → 5 files, 38 tests, all pass:
  `claude-agent-teams-telegram-bridge-formatting.test.ts`, `claude-agent-teams-telegram-client.test.ts`,
  `claude-agent-teams-telegram-bridge.test.ts`, `claude-agent-teams-service.test.ts`, `core.test.ts`.
- `pnpm run check:code-quality:changed` (the CI-enforced gate per AGENTS.md) → passed, 0 findings across
  15 changed files, after fixing: 1 `no-control-regex` (file-level `eslint-disable` comment, matching
  existing repo precedent in `terminal-github-pr-link-detector.ts`), 4 `array-type` (`Array<T>` → `T[]`),
  8 `consistent-type-assertions` (added `oxlint-disable-next-line ... -- SAFETY: ...` comments matching
  existing repo precedent, or removed the assertion by typing a local const instead).
- `git status --porcelain` → only the feature's files changed; reverted an incidental
  `pnpm-lock.yaml` diff (`@pnpm/exe` packageManager entry) both times it reappeared from build tooling.
- Reasoned manually about the "wrong token" case: `sendTelegramMessage`/`fetchTelegramUpdates` throw on
  non-2xx/`ok:false`; the bridge's polling loops catch, log once (flag resets on next success), and
  back off (15s/5s) instead of crashing the team or spinning a tight error loop. Covered by the
  "auth-failure logs once and retries on backoff" test.
- No new npm dependency; used built-in `fetch`.
- Nothing committed — working tree left as-is for team-lead review.

## Design judgment calls to sanity-check

1. Field-ordering trick in `runtime-host-services.ts` (bridge field declared before
   `claudeAgentTeams`, service wired via a free function) instead of a constructor override — avoids
   `runtime-composition-parity.test.ts` churn but is a bit implicit; flag if team prefers an explicit
   constructor.
2. Extended `agentTeams.prepareLaunch` with an optional `telegramBridge` param rather than adding a
   separate RPC method — smaller surface, but couples bridge startup to the prepare-launch call.
3. Bridge targets one pane at a time per team (`watchedPaneId`), switchable via `/watch` — matches
   "any pane, user picks" but there's no multi-pane simultaneous mirroring.
4. Auth/connectivity errors are logged to `console.error` and backed off, not surfaced into the
   Telegram chat itself (chat is unreachable in exactly that failure case anyway) — only pane-level
   errors (unknown pane, send-input failure) get a chat reply.

## Unresolved questions

- None blocking. One open note: `claude-agent-teams-pty-exit-leak.spec.ts` (`.spec.ts`, pre-existing,
  unrelated to this feature) is excluded from vitest's `*.test.ts` glob and wasn't re-run directly;
  my only edit near it (`claude-agent-teams-service.ts`) is additive (new methods, listener hook) and
  doesn't touch any code path that file exercises.
