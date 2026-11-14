# Changelog

## 0.3.1 (unreleased)

- Align the RPC layer with the current pi protocol: `thinking_end` now reads the authoritative `content` field (previously the stale `thinking` name), and the new `agent_settled` event is the definitive idle marker (with a grace fallback for older pi builds that never emit it), so automatic retries, overflow recovery, compaction, steering, and follow-up work no longer settle the UI mid-run or twice per run.
- Handle the new session events `thinking_level_changed`, `session_info_changed`, `entry_appended`, `summarization_retry_scheduled`/`finished`, and `compaction_end.errorMessage`; unknown events remain ignored.
- Respect `data.disposition` on `prompt` responses: a prompt consumed by an extension or input handler (`"handled"`) no longer leaves the UI waiting for a run that never starts, and a consumed steer/follow-up drops its optimistic queued bubble while preserving the composer draft.
- Expose the full current command surface in the client: `follow_up`, `clear_queue`, `get_available_thinking_levels`, `set_session_name`, `compact`, and `export_html` (typed methods added; `RpcCommand` covers every stdin command).
- Queue follow-ups: a ⏭ button in the composer queues the draft to run after the current run; Esc/abort first clears the pi queue (without letting a slow `clear_queue` reply delay the `abort`) and restores the queued drafts into the composer; the queue bar gains a ✕ clear button that also restores drafts; queued bubbles settle into normal messages once the run consumes them.
- Render steered replies in conversation order: when a steer is delivered between turns, the reply starts a fresh assistant bubble below the user's message instead of continuing the bubble above it (driven by the `turn_start` event; plain tool-loop turns keep the same bubble).
- Harden queue-bubble reconciliation: bubbles are gated on the host's `promptResult queued` acknowledgment (no more settling a fresh bubble on a stale `queue_update`) and matched against pi's queue by count, not text, so transformed messages (expanded skills/templates, inline attachments) reconcile correctly; `clear_queue` removes every confirmed queued bubble. A prompt that started a run despite a queued-styled bubble (stale streaming flag) settles its bubble immediately.
- Buffer host draft edits (abort queue restore, insert-prompt) while the composer awaits prompt acknowledgment instead of silently dropping them.
- Keep the UI recoverable when `agent_settled` never arrives: the settle fallback always arms after `agent_end` (15s once pi has proven support, 250ms before), canceled by `agent_start`, `compaction_start`, and `auto_retry_start`; `reset()` re-probes settled support and returns the UI to idle.
- `Pi: Compact Conversation` guards against an active run, shows a cancellable progress notification (cancel aborts compaction), and is bounded by its request timeout; a handled prompt or command refreshes stats without a synthetic `agentEnd`.
- `get_available_thinking_levels` distinguishes failure (`null`, retried on the next refresh) from a real list, passes unknown level names through for forward compatibility, and the webview fallback list is conservative while never resetting an unlisted current level.
- Cycle thinking levels only among the levels the current model actually supports (`get_available_thinking_levels`, refetched on model change and retried after a failed fetch); the fallback list now includes `max` so a `max`-level model is never reset to `off` by a click.
- Coalesce bursty metadata events (`thinking_level_changed`, `session_info_changed`, `entry_appended`) into a single debounced state+stats refresh; `compact` uses a 10-minute request timeout and reports abort/failure as a warning instead of an extension error.
- New commands: `Pi: Compact Conversation`, `Pi: Rename Session`, `Pi: Export Session as HTML`.
- Update RPC type contracts: `get_commands` uses `sourceInfo`, `get_state` carries steering/follow-up modes, message counts, and auto-compaction flag; `message_update` gains cumulative `usage`.

## 0.3.0 (2026-11-03)

- Show the extension version (`v0.3.0`-style) in the sidebar footer, read from the extension's `package.json` at activation.
- Lazily respawn the pi child with its last launch arguments (`--mode rpc`, last `--session`, configured `adapterArgs`) when a request arrives after the child exited or was never started, so rebuilding or upgrading pi no longer requires reloading the window. An explicit stop or dispose disables respawn until the next start.
- Expand `~/` file references against the extension host user's home directory before opening them, including when no workspace is open; preserve relative/absolute paths and line/column navigation.

- Refactor the extension host into focused session/event controllers, services, setup actions and a Node-only RPC transport; use kebab-case TypeScript filenames and separate RPC/webview/edit contracts.
- Isolate shutdown timers, parsers and pending requests per process; await shutdown and report asynchronous spawn errors without unhandled EventEmitter errors.
- Preserve drafts and Undo state on cancelled session changes, serialize transitions, and discard stale history/state/stats/edit work after session changes or disposal.
- Share model selection between the sidebar and command palette, use asynchronous dependency/session discovery with bounded/cached title reads, and explicitly dispose host/view/diff resources.
- Expand host regression coverage for process lifecycle, cancellation, resource ownership, model selection, session metadata and dependency discovery.

- Split the webview frontend into focused ES modules with controller-local state; bundle them into one CSP-compatible script for VS Code. Add module/helper and controller integration regression tests.

- Send images from the file picker, clipboard, and Explorer/Finder drops as Pi RPC image blocks, including image-only and steering prompts.
- Show removable image thumbnails and retain images in live messages and restored session history.
- Validate image format, MIME, bytes, dimensions, count, and selected model capability; preserve rejected drafts for retry.
- Preserve remote file URIs and invalidate pending attachment reads when changing sessions.
- Add image validation, bridge, and browser regression tests.

## 0.2.3 (2026-08-03)

### Performance

- **Typing lag fix**: removed forced layout reflow on every keystroke (CSS `field-sizing: content` replaces JS height calc)
- **Autocomplete IPC gated**: only sends search to extension host when cursor is near `@` or `/` (was every keystroke)
- **Streaming throttle**: textDelta renders via rAF instead of O(n²) re-render per character
- **hljs skip during streaming**: syntax highlighting deferred to agentEnd (saves ~200ms per delta)
- **saveState debounced**: DOM serialization batched at 100ms
- **escapeHtml optimized**: pure string replace instead of temp DOM element
- **Vendor bundle trimmed**: hljs reduced from 254KB to 189KB (20 essential languages)

## 0.2.2 (2026-08-03)

### Docs

- Playwright screenshot harness: 8 automated screenshots (welcome, chat, tools, thinking, edits, workflow, slash commands, model picker)
- README rewritten: Marketplace badges, installation guide, screenshot gallery, development docs
- Repository migrated to `iqbalabiyoga/pi-vscode-chat`

## 0.2.1 (2026-08-02)

### Fixes

- **Provider auth sync**: window reload after `pi /login` so provider list refreshes.
- **Provider toggle**: login/logout + reload QuickPick after auth changes.
- **Model filtering**: only show models from authenticated providers (from `auth.json`).

## 0.2.0 (2026-07-08)

### Major

- **Privacy audit & fix**: environment variable leak fixed — child process now receives only `PATH`, `HOME`, `USER`, `TERM` (not full `process.env`). Added `piChat.extraEnv` setting for opt-in env forwarding.
- **Comprehensive README**: data flow diagram, privacy & data handling disclosure, security recommendations, full dependency tree, troubleshooting table.
- **Extension icon**: custom π + chat bubble icon for Marketplace listing.
- **CHANGELOG, LICENSE** files added per Marketplace recommendations.

### Features

- Streaming chat with real-time markdown + syntax highlighting
- Agent steering (Enter = steer, Esc = abort)
- Slash commands (`/`) with autocomplete
- `@` file search with fuzzy matching
- Edit tracking: Diff / Keep / Undo per edit, Keep all / Undo all batch actions
- Session management: browse, resume previous sessions per workspace
- Live stats: context %, cost, token totals in footer
- Model switching via QuickPick, thinking level cycling
- Extension status chips (rtk toggle, caveman level, agents-team panel)
- Attachments: file picker, image paste, drag & drop
- Theme-native UI (all colors from `--vscode-*` tokens)
- Strict CSP, no CDN assets

### Infrastructure

- Bundled vendor deps: marked + highlight.js via `bun run build:vendor`
- RPC protocol over JSONL stdin/stdout to `pi --mode rpc`
- Process isolation: pi crash never affects VS Code
- Auto-restart on configuration change
- Dependency checker: audits pi binary, bun, node, npm globals, skills, build deps

## 0.1.0 (2026-06-??)

- Initial prototype: basic chat sidebar with pi RPC integration.
