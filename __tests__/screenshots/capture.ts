/**
 * Pi Chat — Screenshot capture harness
 *
 * Launches a standalone HTML page that reproduces the Pi Chat sidebar UI
 * with mock conversation data, then captures high-quality screenshots for
 * the Marketplace README.
 *
 * Usage:
 *   bun run __tests__/screenshots/capture.ts
 *
 * Output: docs/screenshots/*.png
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'docs', 'screenshots');
const HTML_PATH = join(__dirname, 'sidebar.html');

// VSCode Dark+ theme tokens (faithful reproduction)
const VSCODE_DARK_VARS = `
  --vscode-sideBar-background: #252526;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #007acc;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-textLink-foreground: #3794ff;
  --vscode-descriptionForeground: #888888;
  --vscode-editorWidget-background: #252526;
  --vscode-textCodeBlock-background: rgba(128,128,128,0.12);
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --vscode-editor-font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas, "DejaVu Sans Mono", monospace;
  --vscode-widget-border: rgba(128,128,128,0.25);
  --vscode-toolbar-hoverBackground: rgba(128,128,128,0.15);
  --vscode-errorForeground: #f48771;
  --vscode-testing-iconPassed: #73c991;
  --vscode-charts-green: #73c991;
  --vscode-charts-yellow: #cca700;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-gitDecoration-addedResourceForeground: #73c991;
  --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
  --vscode-gitDecoration-deletedResourceForeground: #c74e39;
`;

// ── Scenario definitions ──

interface Scenario {
  name: string;
  description: string;
  html: string;
}

function chatMessage(role: 'user' | 'assistant', content: string, opts?: { thinking?: string; tool?: { name: string; subject: string; args: string; output?: string; status?: 'running' | 'done' | 'error' } }) {
  const icon = role === 'assistant' ? `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0l1.6 5.4L15 7l-5.4 1.6L8 14 6.4 8.6 1 7l5.4-1.6L8 0zm5.5 9.5l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7z"/></svg>` : '';
  const header = role === 'assistant' ? `<div class="message-header">${icon}<span>Pi</span></div>` : '';

  let thinkingHtml = '';
  if (opts?.thinking) {
    thinkingHtml = `
      <details class="thinking-block" open>
        <summary>
          <svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 8l-5-5v10z"/></svg>
          <span class="thinking-label">Thought for 3s</span>
        </summary>
        <div class="thinking-content">${opts.thinking}</div>
      </details>`;
  }

  let toolHtml = '';
  if (opts?.tool) {
    const statusIcon = opts.tool.status === 'error'
      ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="#f48771"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.5 10.5L10.5 12 8 9.5 5.5 12 4.5 10.5 7 8 4.5 5.5 5.5 4.5 8 7l2.5-2.5 1 1L9 8l2.5 2.5z"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 16 16" fill="#73c991"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.2 5.2L7 9.4 5.3 7.7l-.7.7L7 10.8l5-5-.8-.6z"/></svg>`;
    const statusClass = opts.tool.status || 'done';
    toolHtml = `
      <details class="tool-card ${statusClass}" open>
        <summary>
          <span class="tool-status">${statusIcon}</span>
          <span class="tool-icon">📄</span>
          <span class="tool-name">${opts.tool.name}</span>
          <span class="tool-subject">${opts.tool.subject}</span>
          <svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 8l-5-5v10z"/></svg>
        </summary>
        <div class="tool-body">
          <pre class="tool-args"><code>${escapeHtml(opts.tool.args)}</code></pre>
          ${opts.tool.output ? `<pre class="tool-output"><code>${escapeHtml(opts.tool.output)}</code></pre>` : ''}
        </div>
      </details>`;
  }

  return `
    <div class="message ${role}">
      ${header}
      <div class="message-content">
        ${thinkingHtml}
        ${toolHtml}
        <div class="streaming-text">${content}</div>
      </div>
    </div>`;
}

function editCard(filePath: string, editId: string) {
  const fileName = filePath.split('/').pop();
  return `
    <div class="edit-card" id="edit-${editId}">
      <button class="edit-file" title="${filePath}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z"/></svg>
        <span>${fileName}</span>
      </button>
      <div class="edit-actions">
        <button title="Open diff">Diff</button>
        <button class="keep" title="Keep this change">Keep</button>
        <button class="undo" title="Revert this change">Undo</button>
      </div>
    </div>`;
}

function changesBar(count: number, files: string[]) {
  return `
    <div class="changes-bar">
      <span class="changes-label">${count} file${count > 1 ? 's' : ''} changed</span>
      <span class="changes-files">${files.join(', ')}</span>
      <span class="changes-actions">
        <button class="keep">Keep all</button>
        <button class="undo">Undo all</button>
      </span>
    </div>`;
}

function statusBar(stats: { context: string; cost: string; tokens: string }) {
  return `
    <div class="status-bar">
      <span class="stat"><span class="stat-label">ctx</span> ${stats.context}</span>
      <span class="stat"><span class="stat-label">cost</span> ${stats.cost}</span>
      <span class="stat"><span class="stat-label">tok</span> ${stats.tokens}</span>
    </div>`;
}

function modelBar(model: string, thinking: string) {
  return `
    <div class="model-bar">
      <button class="model-btn" title="Change model">${model}</button>
      <button class="thinking-btn" title="Thinking level">${thinking}</button>
    </div>`;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Scenarios ──

const scenarios: Scenario[] = [
  {
    name: '01-welcome',
    description: 'Initial welcome screen when extension loads',
    html: `
      <div class="message assistant">
        <div class="message-content" id="welcome">
          <div class="welcome-title">
            <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.7"><path d="M8 0l1.6 5.4L15 7l-5.4 1.6L8 14 6.4 8.6 1 7l5.4-1.6L8 0zm5.5 9.5l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7z"/></svg>
            <span>Pi Chat</span>
          </div>
          <div class="welcome-sub">AI coding assistant powered by your local pi agent</div>
          <div class="welcome-hints">
            <button class="hint">💬 Start a conversation</button>
            <button class="hint">📎 Drag & drop files</button>
            <button class="hint">⚙️ Configure providers</button>
          </div>
        </div>
      </div>`,
  },
  {
    name: '02-simple-chat',
    description: 'Simple Q&A conversation',
    html: [
      chatMessage('user', 'What is a closure in JavaScript?'),
      chatMessage('assistant', `<p>A <strong>closure</strong> is a function that retains access to its lexical scope even after the outer function has returned.</p>
<pre><code class="language-javascript">function createCounter() {
  let count = 0;
  return {
    increment: () => ++count,
    getCount: () => count
  };
}

const counter = createCounter();
counter.increment(); // 1
counter.increment(); // 2
counter.getCount();  // 2</code></pre>
<p>The inner functions <code>increment</code> and <code>getCount</code> <em>close over</em> the <code>count</code> variable, keeping it alive in memory.</p>`),
    ].join(''),
  },
  {
    name: '03-tool-usage',
    description: 'Agent using tools during conversation',
    html: [
      chatMessage('user', 'Read the package.json and summarize the dependencies'),
      chatMessage('assistant', '', {
        thinking: 'The user wants me to read package.json. I should use the read tool to fetch the file contents, then summarize the devDependencies and any runtime deps.',
      }),
      chatMessage('assistant', '', {
        tool: {
          name: 'read',
          subject: 'package.json',
          args: '{\n  "path": "package.json"\n}',
          output: '{\n  "name": "pi-vscode-chat",\n  "version": "0.2.1",\n  "devDependencies": {\n    "@types/vscode": "^1.98.0",\n    "typescript": "^5.7.0",\n    "marked": "^18.0.5",\n    "highlight.js": "^11.11.1"\n  }\n}',
          status: 'done',
        },
      }),
      chatMessage('assistant', `<p>The project has <strong>4 dev dependencies</strong>:</p>
<ul>
<li><code>@types/vscode</code> — VS Code extension type definitions</li>
<li><code>typescript</code> — TypeScript compiler</li>
<li><code>marked</code> — Markdown parser for rendering chat messages</li>
<li><code>highlight.js</code> — Syntax highlighting for code blocks</li>
</ul>
<p>No runtime dependencies — the extension is self-contained and bundled.</p>`),
    ].join(''),
  },
  {
    name: '04-thinking-block',
    description: 'Reasoning/thinking blocks with collapsible content',
    html: [
      chatMessage('user', 'Review this function for security issues'),
      chatMessage('assistant', '', {
        thinking: `Let me analyze the code carefully:

1. **SQL Injection**: The function uses string concatenation for SQL queries — vulnerable to injection
2. **XSS**: User input is passed directly to innerHTML without sanitization
3. **Path Traversal**: File operations use user-provided paths without validation
4. **Auth bypass**: No authentication check before the database call

I should recommend parameterized queries, input sanitization, path validation, and auth middleware.`,
      }),
      chatMessage('assistant', `<p>I found <strong>3 security issues</strong>:</p>
<ol>
<li><strong>SQL Injection</strong> — Use parameterized queries instead of string concatenation</li>
<li><strong>XSS Vulnerability</strong> — Sanitize user input before rendering</li>
<li><strong>Missing Auth Check</strong> — Add authentication middleware before the handler</li>
</ol>
<p>Want me to fix these?</p>`),
    ].join(''),
  },
  {
    name: '05-edit-tracking',
    description: 'File edit tracking with Keep/Undo actions',
    html: [
      chatMessage('user', 'Fix the typo in the README'),
      chatMessage('assistant', '', {
        thinking: 'The README has "teh" instead of "the" on line 42. I should fix this typo.',
      }),
      chatMessage('assistant', '', {
        tool: {
          name: 'edit',
          subject: 'README.md',
          args: '{\n  "path": "README.md",\n  "oldText": "teh extension",\n  "newText": "the extension"\n}',
          status: 'done',
        },
      }),
      editCard('/workspace/README.md', 'edit-1'),
      changesBar(1, ['README.md']),
      chatMessage('assistant', `<p>Fixed the typo in <code>README.md</code>: <em>"teh extension"</em> → <em>"the extension"</em>.</p>`),
    ].join(''),
  },
  {
    name: '06-full-workflow',
    description: 'Complete agent workflow with steering queue',
    html: [
      chatMessage('user', 'Refactor the authentication module to use JWT tokens'),
      chatMessage('assistant', '', {
        thinking: 'This is a significant refactoring task. I need to:\n1. Read the current auth module\n2. Design the JWT token structure\n3. Implement token generation and validation\n4. Update middleware\n5. Add refresh token logic\n\nLet me start by reading the existing code.',
      }),
      chatMessage('assistant', '', {
        tool: {
          name: 'read',
          subject: 'src/auth.ts',
          args: '{\n  "path": "src/auth.ts"\n}',
          output: '// Current session-based auth...\nexport function authenticate(req, res) {...}',
          status: 'done',
        },
      }),
      chatMessage('assistant', `<p>Found the auth module. I'll refactor it to use JWT tokens. Here's the plan:</p>
<ol>
<li>Replace session store with JWT signing</li>
<li>Add token expiry (15min access, 7d refresh)</li>
<li>Update middleware to validate Bearer tokens</li>
</ol>
<p>Working on it…</p>`),
      editCard('/workspace/src/auth.ts', 'edit-1'),
      editCard('/workspace/src/middleware.ts', 'edit-2'),
      editCard('/workspace/src/types.ts', 'edit-3'),
      changesBar(3, ['auth.ts', 'middleware.ts', 'types.ts']),
    ].join(''),
  },
  {
    name: '07-slash-commands',
    description: 'Autocomplete slash command menu',
    html: `
      <div class="message user">
        <div class="message-content">/</div>
      </div>
      <div class="autocomplete-popup">
        <div class="autocomplete-item active">
          <span class="ac-icon">⚡</span>
          <span class="ac-label">/rtk</span>
          <span class="ac-desc">Run with RTK reasoning</span>
        </div>
        <div class="autocomplete-item">
          <span class="ac-icon">📝</span>
          <span class="ac-label">/caveman</span>
          <span class="ac-desc">Toggle caveman compression</span>
        </div>
        <div class="autocomplete-item">
          <span class="ac-icon">👥</span>
          <span class="ac-label">/team-init</span>
          <span class="ac-desc">Initialize agent team</span>
        </div>
        <div class="autocomplete-item">
          <span class="ac-icon">🔍</span>
          <span class="ac-label">/explore</span>
          <span class="ac-desc">Explore codebase structure</span>
        </div>
        <div class="autocomplete-item">
          <span class="ac-icon">🧪</span>
          <span class="ac-label">/test</span>
          <span class="ac-desc">Run test suite</span>
        </div>
      </div>`,
  },
  {
    name: '08-model-switcher',
    description: 'Model selection QuickPick overlay',
    html: `
      <div class="model-picker-overlay">
        <div class="model-picker">
          <div class="model-picker-header">Select Model</div>
          <div class="model-picker-item active">
            <span class="mp-check">✓</span>
            <span class="mp-name">claude-sonnet-4-20250514</span>
            <span class="mp-provider">anthropic</span>
          </div>
          <div class="model-picker-item">
            <span class="mp-check"></span>
            <span class="mp-name">gpt-4.1</span>
            <span class="mp-provider">openai</span>
          </div>
          <div class="model-picker-item">
            <span class="mp-check"></span>
            <span class="mp-name">gemini-2.5-pro</span>
            <span class="mp-provider">gemini</span>
          </div>
          <div class="model-picker-item">
            <span class="mp-check"></span>
            <span class="mp-name">deepseek-r1</span>
            <span class="mp-provider">deepseek</span>
          </div>
        </div>
      </div>`,
  },
];

// ── HTML template ──

function buildFullHtml(scenarioHtml: string, opts?: { showInput?: boolean; inputValue?: string; showStats?: boolean; showModel?: boolean }) {
  const showInput = opts?.showInput !== false;
  const showStats = opts?.showStats !== false;
  const showModel = opts?.showModel !== false;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi Chat Sidebar</title>
  <style>
    :root {
      ${VSCODE_DARK_VARS}
      --bg: var(--vscode-sideBar-background);
      --bg-input: var(--vscode-input-background);
      --border: var(--vscode-widget-border);
      --border-soft: rgba(128,128,128,0.16);
      --text: var(--vscode-sideBar-foreground);
      --text-dim: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --link: var(--vscode-textLink-foreground);
      --success: var(--vscode-charts-green);
      --error: var(--vscode-errorForeground);
      --hover: var(--vscode-toolbar-hoverBackground);
      --card-bg: var(--vscode-editorWidget-background);
      --code-bg: var(--vscode-textCodeBlock-background);
      --font: var(--vscode-font-family);
      --font-mono: var(--vscode-editor-font-family);
      --radius: 6px;
      --radius-sm: 4px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      color: var(--text);
      background: var(--bg);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Messages ── */

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
      scroll-behavior: smooth;
    }

    .message {
      margin-bottom: 12px;
      animation: fadeIn 0.15s ease;
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 3px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
    }

    .message.user .message-header { display: none; }

    .message-content {
      padding-left: 0;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .message-content p { margin: 0 0 8px; }
    .message-content p:last-child { margin-bottom: 0; }
    .message-content ul, .message-content ol { margin: 0 0 8px; padding-left: 20px; }
    .message-content li { margin-bottom: 2px; }
    .message-content strong { font-weight: 600; }
    .message-content em { font-style: italic; color: var(--text-dim); }
    .message-content code {
      background: var(--code-bg);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .streaming-text { }

    /* ── Code blocks ── */

    pre {
      background: var(--code-bg);
      border-radius: var(--radius);
      padding: 10px 12px;
      margin: 6px 0;
      overflow-x: auto;
      position: relative;
    }

    pre code {
      background: none;
      padding: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text);
    }

    .code-copy {
      position: absolute;
      top: 6px;
      right: 6px;
      background: var(--hover);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-dim);
      cursor: pointer;
      padding: 3px 6px;
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.15s;
    }

    pre:hover .code-copy { opacity: 1; }

    /* ── Thinking blocks ── */

    .thinking-block {
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .thinking-block summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-dim);
      user-select: none;
      background: rgba(128,128,128,0.06);
    }

    .thinking-block summary:hover { background: var(--hover); }

    .thinking-block .chev {
      transition: transform 0.15s;
      flex-shrink: 0;
    }

    .thinking-block[open] .chev { transform: rotate(90deg); }

    .thinking-content {
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-dim);
      white-space: pre-wrap;
      border-top: 1px solid var(--border-soft);
      max-height: 200px;
      overflow-y: auto;
    }

    /* ── Tool cards ── */

    .tool-card {
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .tool-card summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      user-select: none;
      background: rgba(128,128,128,0.06);
    }

    .tool-card summary:hover { background: var(--hover); }

    .tool-card .tool-icon { font-size: 13px; }
    .tool-card .tool-name { font-weight: 600; color: var(--text); }
    .tool-card .tool-subject { color: var(--text-dim); }
    .tool-card .chev {
      margin-left: auto;
      transition: transform 0.15s;
    }
    .tool-card[open] .chev { transform: rotate(90deg); }

    .tool-card .tool-status { flex-shrink: 0; }

    .tool-card.running {
      border-color: var(--accent);
    }

    .tool-card.error {
      border-color: var(--error);
    }

    .tool-body {
      border-top: 1px solid var(--border-soft);
      padding: 8px 10px;
    }

    .tool-args, .tool-output {
      margin: 0 0 6px;
      padding: 6px 8px;
      background: var(--code-bg);
      border-radius: var(--radius-sm);
      font-size: 11px;
      overflow-x: auto;
    }

    .tool-output { margin-bottom: 0; }

    .tool-args code, .tool-output code {
      background: none;
      padding: 0;
      font-size: 11px;
    }

    /* ── Edit cards ── */

    .edit-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 6px 0;
      padding: 6px 10px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }

    .edit-file {
      display: flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      color: var(--link);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font);
    }

    .edit-file:hover { text-decoration: underline; }

    .edit-actions {
      display: flex;
      gap: 4px;
    }

    .edit-actions button {
      background: var(--hover);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      cursor: pointer;
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--font);
    }

    .edit-actions button.keep {
      color: var(--success);
      border-color: rgba(115,201,145,0.3);
    }

    .edit-actions button.undo {
      color: var(--error);
      border-color: rgba(244,135,113,0.3);
    }

    .edit-actions button:hover { opacity: 0.8; }

    .edit-settled {
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .edit-settled.kept { color: var(--success); }
    .edit-settled.undone { color: var(--text-dim); }

    /* ── Changes bar ── */

    .changes-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--card-bg);
      border-top: 1px solid var(--border);
      font-size: 12px;
    }

    .changes-label { font-weight: 600; }
    .changes-files { color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .changes-actions { display: flex; gap: 4px; }

    .changes-actions button {
      background: var(--hover);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      cursor: pointer;
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--font);
    }

    .changes-actions button.keep { color: var(--success); }
    .changes-actions button.undo { color: var(--error); }

    /* ── Input area ── */

    #input-area {
      padding: 8px 12px;
      border-top: 1px solid var(--border);
    }

    #input-row {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 6px 8px;
    }

    #input-row:focus-within {
      border-color: var(--border-focus);
    }

    #input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      outline: none;
      min-height: 20px;
      max-height: 120px;
    }

    #input::placeholder { color: var(--text-dim); }

    #send {
      background: var(--accent);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--accent-fg);
      cursor: pointer;
      padding: 4px 8px;
      font-size: 12px;
      flex-shrink: 0;
      transition: background 0.1s;
    }

    #send:hover { background: var(--vscode-button-hoverBackground); }

    /* ── Status bar ── */

    .status-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 12px;
      font-size: 11px;
      color: var(--text-dim);
      border-top: 1px solid var(--border-soft);
    }

    .stat { display: flex; align-items: center; gap: 3px; }
    .stat-label { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.3px; }

    /* ── Model bar ── */

    .model-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-top: 1px solid var(--border-soft);
    }

    .model-btn, .thinking-btn {
      background: var(--hover);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      cursor: pointer;
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--font);
    }

    .model-btn:hover, .thinking-btn:hover { background: rgba(128,128,128,0.25); }

    /* ── Welcome ── */

    .welcome-title {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
      padding-top: 32px;
    }

    .welcome-sub {
      text-align: center;
      color: var(--text-dim);
      font-size: 12px;
      margin-bottom: 16px;
    }

    .welcome-hints {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .welcome-hints .hint {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font);
      text-align: left;
    }

    .welcome-hints .hint:hover {
      background: var(--hover);
      border-color: var(--accent);
    }

    /* ── Autocomplete ── */

    .autocomplete-popup {
      position: relative;
      background: var(--editor-widget-bg, #252526);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 6px 0;
      max-height: 240px;
      overflow-y: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }

    .autocomplete-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    .autocomplete-item:hover, .autocomplete-item.active {
      background: var(--accent);
      color: var(--accent-fg);
    }

    .ac-icon { font-size: 13px; width: 20px; text-align: center; }
    .ac-label { font-weight: 600; font-family: var(--font-mono); font-size: 12px; }
    .ac-desc { color: var(--text-dim); margin-left: auto; font-size: 11px; }
    .autocomplete-item.active .ac-desc { color: rgba(255,255,255,0.7); }

    /* ── Model picker ── */

    .model-picker-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.3);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 40px;
      z-index: 10;
    }

    .model-picker {
      background: #252526;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 280px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      overflow: hidden;
    }

    .model-picker-header {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
    }

    .model-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
    }

    .model-picker-item:hover { background: var(--hover); }

    .model-picker-item.active {
      background: rgba(14,99,156,0.2);
    }

    .mp-check { width: 16px; text-align: center; color: var(--accent); font-weight: 700; }
    .mp-name { font-family: var(--font-mono); font-size: 12px; }
    .mp-provider { color: var(--text-dim); margin-left: auto; font-size: 11px; }

    /* ── Utilities ── */

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .hidden { display: none !important; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.5); }

    /* ── Language syntax colors (basic) ── */

    .language-javascript .hljs-keyword, .hljs-keyword { color: #c586c0; }
    .language-javascript .hljs-function, .hljs-function { color: #dcdcaa; }
    .language-javascript .hljs-string, .hljs-string { color: #ce9178; }
    .language-javascript .hljs-number, .hljs-number { color: #b5cea8; }
    .language-javascript .hljs-comment, .hljs-comment { color: #6a9955; }
  </style>
</head>
<body>
  ${showModel ? modelBar('claude-sonnet-4-20250514', 'medium') : ''}
  <div id="messages">
    ${scenarioHtml}
  </div>
  ${showInput ? `
  <div id="input-area">
    <div id="input-row">
      <textarea id="input" rows="1" placeholder="Ask Pi anything…" ${opts?.inputValue ? `value="${escapeHtml(opts.inputValue)}"` : ''}></textarea>
      <button id="send">↑</button>
    </div>
  </div>` : ''}
  ${showStats ? statusBar({ context: '42%', cost: '$0.08', tokens: '12.4k' }) : ''}
</body>
</html>`;
}

// ── Capture logic ──

async function captureScreenshots() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('🎭 Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 400, height: 700 },
    deviceScaleFactor: 2, // Retina quality
    colorScheme: 'dark',
  });

  for (const scenario of scenarios) {
    const page = await context.newPage();

    // Determine display options based on scenario
    const opts: { showInput?: boolean; inputValue?: string; showStats?: boolean; showModel?: boolean } = {};
    if (scenario.name === '01-welcome') {
      opts.inputValue = '';
    } else if (scenario.name === '07-slash-commands') {
      opts.inputValue = '/';
    } else if (scenario.name === '08-model-switcher') {
      opts.showModel = false;
      opts.showInput = false;
      opts.showStats = false;
    }

    const html = buildFullHtml(scenario.html, opts);
    await page.setContent(html, { waitUntil: 'networkidle' });

    // Small delay for fonts to load
    await page.waitForTimeout(200);

    const outPath = join(OUTPUT_DIR, `${scenario.name}.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  ✓ ${scenario.name}.png — ${scenario.description}`);

    await page.close();
  }

  await browser.close();
  console.log(`\n📸 Screenshots saved to ${OUTPUT_DIR}/`);
  console.log('   Files:');
  scenarios.forEach(s => console.log(`   - ${s.name}.png`));
}

captureScreenshots().catch((err) => {
  console.error('❌ Capture failed:', err);
  process.exit(1);
});
