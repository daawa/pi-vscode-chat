# Pi Chat for VS Code

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/iqbalabiyoga.pi-vscode-chat?label=Marketplace&color=007acc)](https://marketplace.visualstudio.com/items?itemName=iqbalabiyoga.pi-vscode-chat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.98.0-007acc?logo=visual-studio-code)](https://code.visualstudio.com/)

**Pi Chat** brings your local [pi coding agent](https://github.com/badlogic/pi-mono) into VS Code as a Copilot-style chat sidebar — with **all** pi extensions, skills, providers and multi-agent tooling working out of the box.

> ⚡ The extension is a **UI + RPC bridge layer** — it spawns the `pi` binary installed on your host (`pi --mode rpc`) and talks JSONL over stdin/stdout. It embeds no agent SDK; everything configured in `~/.pi/` (extensions, skills, multi-agent teams, providers) works automatically.

---

## Installation

### From Marketplace (recommended)

1. Open VS Code → **Extensions** (`Cmd+Shift+X`)
2. Search for **"Pi Chat"**
3. Click **Install**

Or install via command line:

```bash
code --install-extension iqbalabiyoga.pi-vscode-chat
```

### From VSIX

1. Download the latest `.vsix` from [Releases](https://github.com/iqbalabiyoga/pi-vscode-chat/releases)
2. Install: `code --install-extension pi-vscode-chat-<version>.vsix`

### Prerequisites

- **pi CLI** — the extension requires the `pi` coding agent on your `PATH`. No pi? Run **`Pi: Install Dependencies`** from the Command Palette — a wizard checks your environment and installs bun + pi + recommended skills.
- **AI Provider Key** — set once with `pi /login` in any terminal (or edit `~/.pi/auth.json` directly).

---

## Screenshots

| Welcome | Chat with Code | Tool Usage |
|:---:|:---:|:---:|
| ![Welcome](docs/screenshots/01-welcome.png) | ![Chat](docs/screenshots/02-simple-chat.png) | ![Tools](docs/screenshots/03-tool-usage.png) |

| Thinking Blocks | Edit Tracking | Slash Commands |
|:---:|:---:|:---:|
| ![Thinking](docs/screenshots/04-thinking-block.png) | ![Edits](docs/screenshots/05-edit-tracking.png) | ![Commands](docs/screenshots/07-slash-commands.png) |

| Full Workflow | Model Switcher |
|:---:|:---:|
| ![Workflow](docs/screenshots/06-full-workflow.png) | ![Models](docs/screenshots/08-model-switcher.png) |

---

## Features

- **Lightweight & Host-Powered** — depends on the `pi` CLI installed on your machine (`~/.pi/` config, extensions, skills and multi-agent teams all work because your real pi runs). A built-in wizard checks dependencies and installs pi for you.
- **Secure Provider Auth** — guide to configure provider API keys via `pi /login` (host pi handles `~/.pi/auth.json`); no keys stored in the extension.
- **Interactive Skills Manager** — inspect and manage skills & extensions (`context-mode`, `pi-superpowers`, `pi-subagents`, `pi-agents-team`, `pi-caveman`, `pi-web-access`, `pi-mcp-adapter`) directly via Command Palette (`Pi: Manage Skills & Extensions`).
- **Visual Diff Badges & Inline View** — real-time `+Added / -Removed` line stats (e.g. `+18 / -3`) on file edits, side-by-side inline diffs, auto-generated unified patch fallbacks, and 1-click Keep / Undo actions.
- **Streaming chat** — real-time markdown rendering, syntax-highlighted code blocks, copy buttons, collapsible thinking (reasoning) blocks.
- **Steering** — keep typing while the agent runs. Enter queues a steering message, Esc aborts.
- **Slash commands** — `/` autocompletes every pi command, skill, prompt template on your machine (rtk, caveman, team-init, etc.).
- **`@` file search** — inline fuzzy file search: `@` + filename to reference workspace files.
- **Edit tracking** — every agent file edit gets Diff / Keep / Undo. A "Keep all / Undo all" changes bar lets you batch-accept or batch-revert edits from the current session.
- **Session management** — persistent JSONL sessions; browse and resume previous pi sessions per workspace.
- **Live stats** — context usage %, session cost, token totals in the footer.
- **Model & thinking level** — QuickPick to switch models; cycle reasoning effort (off → minimal → low → medium → high → xhigh) from the toolbar.
- **Extension status chips** — pi extensions surface as interactive chips: toggle rtk on/off, change caveman compression level, open the agents-team panel (Init / Result / Stop).
- **Attachments** — VS Code file picker, image paste from clipboard, drag & drop from Explorer or Finder.
- **Theme-native UI** — every color derives from VS Code theme tokens. Light, dark, and high-contrast all work. No CDN assets. Strict Content Security Policy.

---

## Commands

| Command | Keybinding | Description |
|---|---|---|
| `Pi: Configure AI Provider & Keys` | — | Guide to configure provider keys via `pi /login` (host pi handles `~/.pi/auth.json`) |
| `Pi: Manage Skills & Extensions` | — | Inspect & install pi skills (`context-mode`, `pi-subagents`, etc.) |
| `Pi: Check Dependencies` | — | Audit pi binary, skills, and build dependencies |
| `Pi: Install Dependencies` | — | Run the dependency wizard (installs bun, pi, and skills) |
| `Pi: New Session` | — | Start a fresh conversation |
| `Pi: Select Model` | — | Pick model/provider from available options |
| `Pi: Accept Edit` | — | Keep a pending edit |
| `Pi: Reject Edit` | — | Revert a pending edit |
| `Pi: Abort Current Task` | — | Stop the currently running agent |
| `Pi Chat: Ask About Selection` | Editor context menu | Send selected code to chat with file path and line numbers |

---

## Privacy & Data Handling

Understanding how data flows through Pi Chat is important — especially since the extension connects to AI providers.

### Data flow

```
Your code / files / images
    │
    ▼
VS Code Extension Host ◄────────────►  pi --mode rpc (child process)
    │                                        │
    │                                   [your local machine]
    │                                        │
    ▼                                        ▼
Webview (sidebar UI)                  AI provider
(no network access,                     (any provider configured in pi)
 only local webview)                    │
                                        ▼
                                  External API servers
```

### What data is sent to AI providers

Everything you type, attach, or that pi reads during execution is sent through pi to whichever AI provider you've configured:

- **Chat messages** — your prompts, questions, code requests
- **Attached files** — files selected via file picker, or dropped/pasted into the chat
- **Source code** — pi's `read`, `grep`, `find`, `ls` tools read workspace files. pi passes relevant excerpts to the AI provider
- **Images** — pasted from clipboard or dropped into the webview (converted to base64)
- **Workspace structure** — file paths, directory names, project scaffolding

### What stays local

- **Edit snapshots** — file snapshots for accept/revert are stored in extension memory only
- **Session list** — session files are read from `~/.pi/agent/sessions/*.jsonl` and their titles displayed; the raw session files are never sent externally
- **VS Code state** — the webview's rendered message HTML is persisted via `vscode.setState()` (VS Code's Extension Storage); this stays on disk locally unless you use Settings Sync

### Security recommendations

1. **Do not paste API keys, passwords, or tokens into chat prompts** — they will be sent to the AI provider
2. **Review your provider's data policy** — pi sends code to whatever provider you configure (each provider has its own data usage policy)
3. **Use `piChat.extraEnv` for credentials** — pass API keys through env vars instead of in prompts
4. **Clear sessions** regularly — `Pi: New Session` starts fresh; old sessions remain on disk under `~/.pi/agent/sessions/`
5. **Be mindful of drag & drop** — files dropped from Finder are automatically read and their contents may be sent to the AI provider
6. **Check `piChat.piPath`** — only install pi from trusted sources (`@earendil-works/pi-coding-agent` on npm)

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  VS Code Extension Host                          │
│  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  PiRpcClient          │  │  EditManager      │  │
│  │  ─ child process mgr  │  │  ─ snapshot/revert│  │
│  │  ─ JSONL stdin/stdout │  │  ─ diff tracking  │  │
│  └──────────┬───────────┘  └──────────────────┘  │
│             │                                     │
│  ┌──────────▼───────────┐                        │
│  │  ChatSidebarProvider   │                      │
│  │  ─ WebviewViewProvider│                      │
│  │  ─ event bridge       │                       │
│  │  ─ message routing    │                       │
│  └──────────┬───────────┘                        │
│             │ postMessage / onDidReceiveMessage   │
└─────────────┼────────────────────────────────────┘
              │
              ▼
┌────────────────────────────┐
│  Webview (sidebar)          │
│  ─ vanilla JS, no framework │
│  ─ marked + highlight.js    │
│  ─ CSP: local scripts only  │
│  ─ all colors from theme    │
└────────────────────────────┘
              ▲
              │ JSONL over stdin/stdout
              │
┌─────────────────────────────┐
│  pi --mode rpc (child)       │
│  ─ all extensions & skills   │
│  ─ configured AI provider    │
│  ─ multi-agent, subagents    │
│  ─ sessions, filesystem, etc │
└─────────────────────────────┘
```

### Key design decisions

- **No agent SDK embedded** — the extension is pure UI + RPC bridge. Everything pi-related comes from the real binary
- **Process isolation** — a pi crash cannot take down VS Code (separate OS process)
- **Sessions persist by default** — the child process writes session files to `~/.pi/agent/sessions/`; history loads through RPC, respecting branches and compaction
- **CSP-locked webview** — no inline scripts, no CDN, `default-src 'none'`. All webview assets (CSS, JS, vendor bundle) ship with the extension
- **Minimal env exposure** — only `PATH`, `HOME`, `USER`, `TERM` are forwarded to the child process by default (not the full `process.env`); opt-in via `piChat.extraEnv`

---

## Development

```bash
bun install                    # Install build deps (marked, highlight.js, TypeScript)
bun run compile                # Full build: vendor + extension + type check
bun run build                  # Extension bundle only (fast iteration)
bun run build:vendor           # Vendor bundle only (marked + hljs)
bun run watch                  # tsc -watch for type checking only
bun run screenshots            # Regenerate documentation screenshots (Playwright)
```

Press **F5** to launch the Extension Development Host (`.vscode/launch.json` runs `npm: compile` first).

### Project structure

```
src/
├── extension.ts              # Activation, command registration, dependency check
├── piRpcClient.ts            # Child process manager, JSONL protocol
├── chatSidebarProvider.ts    # WebviewViewProvider, event bridge
├── editManager.ts            # File snapshots, accept/revert tracking
├── types.ts                  # All message shapes (RPC, webview, events)
media/
├── main.js                   # Webview frontend (vanilla JS)
├── style.css                 # Theme-native styles (--vscode-* tokens)
├── vendor-entry.js           # Entry point for vendor bundle
├── vendor.js                 # Bundled marked + highlight.js (built)
__tests__/
└── screenshots/
    ├── capture.ts            # Playwright screenshot harness
    └── *.png                 # Generated screenshots
```

### READ THIS

- The `out/extension.js` entry point is produced by **bun build**, not `tsc`. `tsc` only type-checks. If changes don't take effect, rebuild the bun bundle.
- All message shapes across all three boundaries (RPC ↔ extension host ↔ webview) are defined in `src/types.ts` — single source of truth.
- The webview has zero npm dependencies at runtime — all JS ships with the extension. No CDN. Strict CSP.
- Colors come from `--vscode-*` CSS variables. No hard-coded palette.
- Screenshots are regenerated via `bun run screenshots` (Playwright + Chromium, `__tests__/screenshots/capture.ts`).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "pi not found" | pi binary not on PATH | Run **Pi: Install Dependencies** or `bun add -g @earendil-works/pi-coding-agent`. Check `piChat.piPath` setting |
| "Failed to start pi process" | Wrong path or permission | Verify `piChat.piPath` points to a valid binary. Check VS Code Developer Tools console for details |
| "No models available" | No AI provider configured | pi needs at least one provider. Run `pi /login` in the terminal, or set provider API keys in `piChat.extraEnv` |
| Skills not loading | Global install missing | `bun pm ls -g` to check; `bun add -g <name>` to install. Restart VS Code |
| Webview blank / not loading | Vendor bundle issue | Rebuild: `bun run build:vendor`. Check Extension Host logs |
| Chat history missing after reload | State cleared | Sessions are persisted in `~/.pi/agent/sessions/` — click **History** button to resume one |
| "Compacting conversation" | Context window full | Normal — pi compacts the conversation to fit. The agent pauses briefly |
| Extension commands not found | Extension not activated | Open the Pi Chat sidebar to activate, or run any Pi command from the palette |

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Publishing

```bash
bun run compile                    # full build
vsce publish --no-dependencies     # publishes to Marketplace
```

See [EXTENSION.md](EXTENSION.md) for the full publishing lifecycle, version management, and CI/CD setup.

---

*Built with [pi](https://github.com/badlogic/pi-mono) — the open-source coding agent for your terminal, now in your editor.*
