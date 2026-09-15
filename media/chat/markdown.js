import { escapeHtml, createElement } from './dom.js';
import { ICONS } from './icons.js';

// ── File reference linkification ──
// Turns inline code like `src/foo.ts:12`, `src/foo.ts:12-34`, `package.json`
// or `/abs/path/README.md` into a clickable chip that opens the file in VS Code.
const FILE_REF_RE = /^(.+?):(\d+)(?:-(\d+))?$/;

// Known file extensions for bare filenames (no path separator) such as
// `package.json`. This avoids treating stuff like `example.com` as a path.
const FILE_EXT_RE = /\.(?:[jt]sx?|jsx|mjs|cjs|json|jsonc|md|mdx|txt|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|swift|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|env|css|scss|sass|less|html|htm|vue|svelte|sql|graphql|gql|prisma|lock|xml|svg|png|jpe?g|gif|webp|ico)$/i;

function looksLikePath(p) {
  if (!p || /:\/\//.test(p)) return false; // skip URLs
  // Be conservative: inline code is not necessarily a path just because it
  // contains a slash. Allow ordinary filename characters, not code/regex syntax.
  // Strip a Windows drive or home prefix before validating path components.
  const path = p.replace(/^[a-z]:[/\\]/i, '').replace(/^~[/\\]/, '');
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (!parts.length || !parts.every((part) =>
    part === '.' || part === '..' ||
    (part === part.trim() && /^[\p{L}\p{N}_.@+ -]+$/u.test(part) && /[\p{L}\p{N}_]/u.test(part))
  )) return false;
  // Separators and navigation components alone (/, \\, ../, etc.) aren't files.
  if (!parts.some((part) => part !== '.' && part !== '..')) return false;
  return /[/\\]/.test(p) || FILE_EXT_RE.test(p);
}

export function fileRefParts(text) {
  if (!text || text.length > 512) return null;
  const s = text.trim();
  // path:line or path:line-endline
  const m = FILE_REF_RE.exec(s);
  if (m) {
    const p = m[1].trim();
    if (!looksLikePath(p)) return null;
    return { filePath: p, line: parseInt(m[2], 10), endLine: m[3] ? parseInt(m[3], 10) : undefined };
  }
  // plain path without a line number
  if (looksLikePath(s)) return { filePath: s, line: undefined, endLine: undefined };
  return null;
}

function makeFileRef(text) {
  const parts = fileRefParts(text);
  if (!parts) return null;
  const { filePath } = parts;
  const line = parts.line;
  const endLine = parts.endLine;

  const a = document.createElement('a');
  a.className = 'file-ref';
  a.href = '#';
  a.dataset.filePath = filePath;
  if (line) a.dataset.line = String(line);
  if (endLine) a.dataset.endLine = String(endLine);
  a.dataset.fileLinked = '1';
  a.title = `Open ${filePath}${line ? ':' + line + (endLine ? '-' + endLine : '') : ''}`;
  a.innerHTML = `${ICONS.file}<span class="file-ref-name">${escapeHtml(filePath)}</span>${line ? `<span class="file-ref-line">:${line}${endLine ? '-' + endLine : ''}</span>` : ''}`;
  return a;
}

function linkifyFileRefs(root) {
  // Inline code such as `src/foo.ts:12`
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return; // handled below for single-line blocks
    const a = makeFileRef(code.textContent);
    if (a) code.replaceWith(a);
  });

  // Single-line fenced code blocks that are just a file reference
  root.querySelectorAll('pre > code').forEach((code) => {
    const text = code.textContent.trim();
    if (!text || text.includes('\n')) return;
    const a = makeFileRef(text);
    if (a) {
      const pre = code.closest('pre');
      if (pre) pre.replaceWith(a);
    }
  });
}

export function renderMarkdown(container, text, streaming) {
  try {
    container.innerHTML = window.marked ? window.marked.parse(text) : escapeHtml(text);
  } catch {
    container.textContent = text;
  }
  // Skip expensive syntax highlighting during streaming — full highlight on agentEnd
  if (!streaming) {
    container.querySelectorAll('pre code').forEach((block) => {
      if (window.hljs && !block.dataset.hl) {
        try { window.hljs.highlightElement(block); block.dataset.hl = '1'; } catch {}
      }
    });
  }
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const btn = createElement('button', 'code-copy', ICONS.copy);
    btn.title = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText);
      btn.innerHTML = ICONS.check;
      setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1200);
    });
    pre.appendChild(btn);
  });
  linkifyFileRefs(container);
}
// Full highlight pass — called on agentEnd to highlight all code blocks
export function highlightAll(container) {
  if (!window.hljs) return;
  container.querySelectorAll('pre code').forEach((block) => {
    if (!block.dataset.hl) {
      try { window.hljs.highlightElement(block); block.dataset.hl = '1'; } catch {}
    }
  });
}

export function createStreamingRenderer() {

  let _renderPending = null;
  let _renderScheduled = false;
  function throttledRender(container, text) {
    _renderPending = { container, text };
    if (!_renderScheduled) {
      _renderScheduled = true;
      requestAnimationFrame(() => {
        _renderScheduled = false;
        const p = _renderPending;
        if (p) { _renderPending = null; renderMarkdown(p.container, p.text, true); }
      });
    }
  }
  function flushRender() {
    _renderScheduled = false;
    const p = _renderPending;
    if (p) { _renderPending = null; renderMarkdown(p.container, p.text, false); }
  }

  return { throttledRender, flushRender };
}
