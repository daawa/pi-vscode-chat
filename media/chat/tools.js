import { $, cleanAnsi, escapeHtml, createElement } from './dom.js';
import { ICONS, TOOL_ICONS } from './icons.js';

export function toolIcon(name) {
  const key = (name || '').toLowerCase();
  for (const k of Object.keys(TOOL_ICONS)) {
    if (key === k || key.startsWith(k)) return TOOL_ICONS[k];
  }
  return ICONS.wrench;
}

export function toolSubject(name, args) {
  try {
    if (!args) return '';
    if (typeof args === 'string') args = JSON.parse(args);
    if (args.command) return String(args.command).split('\n')[0];
    const p = args.path || args.file_path || args.filePath;
    if (p) return String(p).split(/[\\/]/).pop();
    if (args.pattern) return String(args.pattern);
    if (args.url) return String(args.url);
    if (args.query) return String(args.query);
    const first = Object.values(args).find(v => typeof v === 'string');
    return first ? String(first).split('\n')[0] : '';
  } catch { return ''; }
}

export function setToolState(card, status) {
  card.classList.remove('running', 'done', 'error', 'interrupted', 'unknown');
  card.classList.add(status);
  const statusEl = card.querySelector('.tool-status');
  statusEl.innerHTML = status === 'running' ? '<span class="spinner"></span>'
    : status === 'done' ? ICONS.check
    : status === 'unknown' ? '?'
    : ICONS.cross;
  const label = {
    running: 'Running',
    done: 'Succeeded',
    error: 'Failed',
    interrupted: 'Interrupted — no result received',
    unknown: 'No result available',
  }[status];
  statusEl.title = label;
  statusEl.setAttribute('aria-label', label);
}

export function renderInlineDiff(card, filePath, newContent, diffText) {
  const body = card.querySelector('.tool-body');
  if (!body) return;

  // Clean up any existing diff container
  const existingDiff = card.querySelector('.tool-diff');
  if (existingDiff) existingDiff.remove();

  // Create diff container
  const diffContainer = createElement('div', 'tool-diff');
  diffContainer.innerHTML = `
    <div class="diff-header">
      <span class="diff-icon">📝</span>
      <span class="diff-title">Changes to <strong>${escapeHtml(filePath.split(/[\\/]/).pop())}</strong></span>
      <button class="diff-toggle" title="Toggle diff view">${ICONS.chevron}</button>
    </div>
    <div class="diff-content hidden"></div>`;

  const diffContent = diffContainer.querySelector('.diff-content');

  try {
    let addedCount = 0;
    let removedCount = 0;
    if (diffText) {
      const lines = diffText.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) addedCount++;
        else if (line.startsWith('-') && !line.startsWith('---')) removedCount++;
      }
    }

    const titleEl = diffContainer.querySelector('.diff-title');
    if (titleEl) {
      titleEl.innerHTML = `Changes to <strong>${escapeHtml(filePath.split(/[\\/]/).pop())}</strong> <span class="diff-badge added">+${addedCount}</span> <span class="diff-badge removed">-${removedCount}</span>`;
    }

    // Try to parse diff as unified diff format
    const diff2html = window.Diff2Html;
    if (diff2html && diff2html.parse(diffText).length) {
      // Normalize line endings
      const normalizedDiff = diffText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const html = diff2html.html(normalizedDiff, {
        inputFormat: 'diff',
        outputFormat: 'side-by-side',
        showFiles: false,
        matching: 'lines',
        diffStyle: 'side-by-side',
      });
      diffContent.innerHTML = html;
    } else {
      // Fallback: show raw diff
      diffContent.innerHTML = `<pre><code class="language-diff">${escapeHtml(diffText)}</code></pre>`;
    }
  } catch (e) {
    console.error('Failed to render diff:', e);
    diffContent.innerHTML = `<pre><code class="language-diff">${escapeHtml(diffText)}</code></pre>`;
  }

  body.appendChild(diffContainer);

  // Add toggle behavior
  const toggleBtn = diffContainer.querySelector('.diff-toggle');
  const diffContentEl = diffContainer.querySelector('.diff-content');
  if (toggleBtn && diffContentEl) {
    toggleBtn.addEventListener('click', () => {
      diffContentEl.classList.toggle('hidden');
      toggleBtn.innerHTML = diffContentEl.classList.contains('hidden') ? ICONS.chevron : ICONS.cross;
    });
  }
}

export function createToolCards({ vscode, state, getOrCreateMessage, scrollToBottom, saveState }) {
  const changesBar = $('changes-bar');
  function addToolCard(msg) {
    const toolMsg = document.querySelector(`[data-msg-id="${msg.messageId === 'current' ? state.currentMessageId : msg.messageId}"]`) || getOrCreateMessage('assistant');
    const content = toolMsg.querySelector('.message-content');

    const subject = toolSubject(msg.toolName, msg.args);
    const card = createElement('details', 'tool-card');
    card.id = `tool-${msg.toolCallId}`;
    card.innerHTML = `
      <summary>
        <span class="tool-status"></span>
        <span class="tool-icon">${toolIcon(msg.toolName)}</span>
        <span class="tool-name">${escapeHtml(msg.toolName)}</span>
        <span class="tool-subject">${escapeHtml(subject)}</span>
        ${ICONS.chevron}
      </summary>
      <div class="tool-body">
        <pre class="tool-args"><code>${escapeHtml(typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args, null, 2))}</code></pre>
        <pre class="tool-output hidden"><code></code></pre>
      </div>`;
    setToolState(card, 'running');
    content.appendChild(card);
    scrollToBottom();
  }

  function updateToolCard(toolCallId, output) {
    const card = document.getElementById(`tool-${toolCallId}`);
    if (!card) return;
    const out = card.querySelector('.tool-output');
    out.classList.remove('hidden');
    const code = out.querySelector('code');
    const text = cleanAnsi(output);
    code.textContent = text.length > 8000 ? text.slice(-8000) : text;
    out.scrollTop = out.scrollHeight;
  }

  function endToolCard(msg) {
    const card = document.getElementById(`tool-${msg.toolCallId}`);
    if (!card) return;
    setToolState(card, msg.isError ? 'error' : 'done');
    if (msg.isError) card.querySelector('.tool-diff')?.remove();
    if (msg.output) {
      const out = card.querySelector('.tool-output');
      out.classList.remove('hidden');
      const text = cleanAnsi(msg.output);
      out.querySelector('code').textContent = text.length > 8000 ? text.slice(0, 8000) + '\n…(truncated)' : text;
    }
    saveState();
  }

  function updateToolDiff(msg) {
    const card = document.getElementById(`tool-${msg.toolCallId}`);
    // Diff enrichment must never change a tool's execution outcome.
    if (!card?.classList.contains('done') || !msg.diff || !msg.filePath) return;
    renderInlineDiff(card, msg.filePath, msg.fileContent || '', msg.diff);
    saveState();
  }

  // ── Edit cards & changes bar ──

  function addEditCard(filePath, id) {
    // Repeated edits to a pending file update its existing review card.
    if (document.getElementById(`edit-${id}`)) return;
    const msg = getOrCreateMessage('assistant');
    const content = msg.querySelector('.message-content');
    const fileName = filePath.split(/[\\/]/).pop();

    const card = createElement('div', 'edit-card');
    card.id = `edit-${id}`;
    card.innerHTML = `
      <button class="edit-file" data-action="openFile" data-path="${escapeHtml(filePath)}" title="${escapeHtml(filePath)}">
        ${ICONS.pencil}<span>${escapeHtml(fileName)}</span>
      </button>
      <div class="edit-actions">
        <button data-action="showDiff" data-edit="${id}" title="Open diff">Diff</button>
        <button data-action="acceptEdit" data-edit="${id}" class="keep" title="Keep this change">Keep</button>
        <button data-action="revertEdit" data-edit="${id}" class="undo" title="Revert this change">Undo</button>
      </div>`;
    content.appendChild(card);
    saveState();
    scrollToBottom();
  }

  function settleEditCard(editId, accepted) {
    const card = document.getElementById(`edit-${editId}`);
    if (card) {
      const actions = card.querySelector('.edit-actions');
      if (actions) actions.innerHTML = `<span class="edit-settled ${accepted ? 'kept' : 'undone'}">${accepted ? ICONS.check + ' Kept' : '↩ Undone'}</span>`;
    }
    saveState();
  }

  function renderChangesBar(pending) {
    if (!pending || pending.length === 0) {
      changesBar.classList.add('hidden');
      changesBar.innerHTML = '';
      return;
    }
    changesBar.classList.remove('hidden');
    const names = pending.map(p => escapeHtml(p.filePath.split(/[\\/]/).pop()));
    changesBar.innerHTML = `
      <span class="changes-label">${pending.length} file${pending.length > 1 ? 's' : ''} changed</span>
      <span class="changes-files" title="${names.join(', ')}">${names.slice(0, 3).join(', ')}${pending.length > 3 ? '…' : ''}</span>
      <span class="changes-actions">
        <button data-action="acceptAllEdits" class="keep">Keep all</button>
        <button data-action="revertAllEdits" class="undo">Undo all</button>
      </span>`;
  }

  // Event delegation for all data-action buttons (CSP-safe)
  document.addEventListener('click', (e) => {
    // Clickable file reference (e.g. src/foo.ts:12)
    const fileRef = e.target.closest('.file-ref');
    if (fileRef) {
      e.preventDefault();
      vscode.postMessage({
        type: 'openFile',
        path: fileRef.dataset.filePath,
        line: fileRef.dataset.line ? parseInt(fileRef.dataset.line, 10) : undefined,
        column: fileRef.dataset.column ? parseInt(fileRef.dataset.column, 10) : undefined,
      });
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'openFile') {
      vscode.postMessage({
        type: 'openFile',
        path: btn.dataset.path,
        line: btn.dataset.line ? parseInt(btn.dataset.line, 10) : undefined,
        column: btn.dataset.column ? parseInt(btn.dataset.column, 10) : undefined,
      });
    } else if (action === 'acceptAllEdits' || action === 'revertAllEdits') {
      vscode.postMessage({ type: action });
    } else if (btn.dataset.edit) {
      vscode.postMessage({ type: action, editId: btn.dataset.edit });
    }
  });

  return { addToolCard, updateToolCard, endToolCard, updateToolDiff, addEditCard, settleEditCard, renderChangesBar };
}
