import { createElement } from './dom.js';
import { ICONS } from './icons.js';

export function fileUri(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/^["']|["']$/g, '');
  // Keep remote authority and encoded path intact for workspace.fs.
  if (/^(file|vscode-remote):\/\//.test(text)) return text;
  if (text.startsWith('vscode-file://')) {
    try { return 'file://' + new URL(text).pathname; } catch { return ''; }
  }
  if (text.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(text)) {
    const uri = new URL('file:///');
    uri.pathname = text.replace(/\\/g, '/');
    return uri.href;
  }
  return '';
}

// VS Code forwards native drags into a webview when Shift is held.
export function bindDropInput({ inputEl, attachments, isLocked }) {
  // ── Paste image ──

  inputEl.addEventListener('paste', (e) => {
    if (isLocked()) return;
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return; // Preserve the browser's normal text paste.
    e.preventDefault();
    // A clipboard can contain both text and pixels (e.g. copied from a browser).
    const text = clipboard.getData('text/plain');
    if (text) {
      inputEl.setRangeText(text, inputEl.selectionStart, inputEl.selectionEnd, 'end');
      inputEl.dispatchEvent(new Event('input'));
    }
    files.forEach(file => { void attachments.attachImageFile(file); });
  });

  // ── Drag & drop ──
  // Sources handled:
  //  1. VS Code explorer/editor tabs → 'application/vnd.code.uri-list', 'codefiles', 'resourceurls', 'text/uri-list'
  //  2. Finder / OS → dataTransfer.files (read local bytes, even with a remote host)
  //  3. Plain text paths

  const dropZone = createElement('div', 'hidden');
  dropZone.id = 'drop-zone';
  dropZone.innerHTML = `<div class="drop-zone-inner">${ICONS.file}<span>Drop files to attach</span></div>`;
  document.body.appendChild(dropZone);

  let dragDepth = 0;
  function showDropZone(show) { dropZone.classList.toggle('hidden', !show); }

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    showDropZone(true);
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropZone(false);
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  function attachUris(values) {
    const uris = [...new Set(values.map(fileUri).filter(Boolean))];
    if (!uris.length) return false;
    attachments.attachUris(uris);
    return true;
  }

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showDropZone(false);
    if (isLocked()) return;
    const dt = e.dataTransfer;
    if (!dt) return;

    // Explorer/editor resources are read by the extension host, including SSH URIs.
    const codeUris = dt.getData('application/vnd.code.uri-list');
    if (codeUris && attachUris(codeUris.split(/[\r\n]+/))) return;
    for (const format of ['resourceurls', 'codefiles']) {
      try {
        const values = JSON.parse(dt.getData(format) || 'null');
        if (Array.isArray(values) && attachUris(values)) return;
      } catch { /* Not a VS Code resource list. */ }
    }

    // Read OS File bytes before generic URI text: a local Finder path is not a
    // file on a remote extension host, and images must never become @path text.
    if (dt.files.length) {
      for (const file of dt.files) {
        if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|avif|heic|heif)$/i.test(file.name)) {
          void attachments.attachImageFile(file);
        } else {
          void attachments.attachTextFile(file);
        }
      }
      return;
    }
    attachUris((dt.getData('text/uri-list') || dt.getData('text/plain')).split(/[\r\n]+/));
  });
}
