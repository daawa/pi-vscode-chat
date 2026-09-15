import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const defaultStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'style.css'),
  );
  const customStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'style.custom.css'),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.bundle.js'),
  );
  const vendorUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'vendor.js'),
  );

  const nonce = randomBytes(32).toString('hex');

  return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource};">
  <link id="chat-style" rel="stylesheet" href="${customStyleUri}" data-default="${defaultStyleUri}" data-custom="${customStyleUri}">
  <title>Pi Chat</title>
</head>
<body>
  <div id="app">
    <div id="session-header" class="hidden" role="status" aria-live="polite">
      <span class="session-label">Session</span>
      <span id="session-name"></span>
      <span id="session-id" class="hidden"></span>
    </div>
    <div id="sessions-panel" class="hidden">
      <div id="sessions-panel-header">
        <span>Chat history</span>
        <button id="btn-close-sessions" title="Close" aria-label="Close">✕</button>
      </div>
      <div id="sessions-list"></div>
    </div>

    <div id="team-monitor" class="hidden">
      <div id="team-monitor-header">
        <span>Agent team</span>
        <span id="team-active-count" class="badge">0 active</span>
        <span class="team-actions">
          <button class="team-action" data-cmd="/team-init" title="Rewrite/initialize the team for this project">Init</button>
          <button class="team-action" data-cmd="/team-result" title="Show the latest team result">Result</button>
          <button class="team-action danger" data-cmd="/team-stop" title="Stop all workers">Stop</button>
          <button id="btn-close-team" title="Close panel">✕</button>
        </span>
      </div>
      <div id="team-grid"></div>
    </div>

    <div id="messages" aria-live="polite"></div>

    <div id="dialog-overlay" class="hidden"></div>

    <div id="bottom">
      <div id="status-bar" class="hidden"></div>
      <div id="widgets-container" class="hidden"></div>
      <div id="queue-bar" class="hidden"></div>
      <div id="changes-bar" class="hidden"></div>

      <div id="input-area">
        <div id="autocomplete" class="hidden"></div>
        <div id="input-container">
          <div id="attachment-list"></div>
          <div id="attachment-status" class="hidden" role="status" aria-live="polite"></div>
          <textarea id="input" rows="1" placeholder="Ask Pi — @ for files, / for commands"></textarea>
          <div id="input-toolbar">
            <div class="left-actions">
              <button id="btn-attach" class="icon-button" title="Attach file">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12.5 4.5v6a4.5 4.5 0 0 1-9 0v-7a3 3 0 0 1 6 0v7a1.5 1.5 0 0 1-3 0v-6"/></svg>
              </button>
              <button id="btn-key" class="icon-button" title="Configure AI Provider Keys & OAuth">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7.5 7.5A4.5 4.5 0 1 1 12 3a4.5 4.5 0 0 1-4.5 4.5zm0 0L2 13v2h2l1.5-1.5H7l1-1"/></svg>
              </button>
              <button id="btn-model" class="pill" title="Change model"><span id="model-name">…</span><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6l4 4 4-4"/></svg></button>
              <button id="btn-thinking" class="pill hidden" title="Thinking level"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a5 5 0 0 0-3 9v2.5A1.5 1.5 0 0 0 6.5 14h3a1.5 1.5 0 0 0 1.5-1.5V10a5 5 0 0 0-3-9zM6.5 15.3h3v.2a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5v-.2z"/></svg><span id="thinking-level">off</span></button>
            </div>
            <div class="right-actions">
              <button id="btn-send" class="icon-button send" title="Send (Enter)" disabled aria-label="Send">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.72 1.05a.5.5 0 0 0-.71.55l1.4 4.85a.5.5 0 0 0 .4.35l5.69.96c.26.05.26.43 0 .48l-5.69.96a.5.5 0 0 0-.4.35l-1.4 4.85a.5.5 0 0 0 .71.55l13.32-6.69a.5.5 0 0 0 0-.9L1.72 1.05z"/></svg>
              </button>
              <button id="btn-abort" class="icon-button stop hidden" title="Stop (Esc)" aria-label="Stop">
                <svg width="14" height="14" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div id="footer-bar">
          <div id="footer-left">
            <button id="btn-history" class="footer-link" title="Chat history">🕘 History</button>
            <button id="btn-new" class="footer-link" title="New chat">💬 New chat</button>
            <button id="btn-keys" class="footer-link" title="Configure AI Provider Keys">🔑 Keys</button>
            <button id="btn-style" class="footer-link" title="Select chat style">🎨 Style</button>
          </div>
          <div id="footer-stats" title="Session usage"></div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${vendorUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
