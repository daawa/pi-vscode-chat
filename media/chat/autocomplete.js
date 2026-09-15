import { $, escapeHtml, createElement } from './dom.js';
import { ICONS } from './icons.js';

export function createAutocomplete({ vscode, inputEl }) {
  const autocompleteEl = $('autocomplete');
  let piCommands = [];
  let acItems = [];
  let acIndex = 0;
  let acKind = null; // 'file' | 'command'

  function showAutocomplete(items, kind) {
    acItems = items;
    acIndex = 0;
    acKind = kind;
    if (!items.length) { hideAutocomplete(); return; }
    autocompleteEl.classList.remove('hidden');
    renderAutocomplete();
  }

  function renderAutocomplete() {
    autocompleteEl.innerHTML = '';
    acItems.forEach((item, i) => {
      const row = createElement('div', `ac-item${i === acIndex ? ' selected' : ''}`);
      row.innerHTML = `
        <span class="ac-icon">${acKind === 'file' ? ICONS.file : ICONS.terminal}</span>
        <span class="ac-label">${escapeHtml(item.label)}</span>
        <span class="ac-detail">${escapeHtml(item.detail || '')}</span>`;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptAutocomplete(i); });
      row.addEventListener('mousemove', () => { if (acIndex !== i) { acIndex = i; renderAutocomplete(); } });
      autocompleteEl.appendChild(row);
    });
  }

  function hideAutocomplete() {
    autocompleteEl.classList.add('hidden');
    autocompleteEl.innerHTML = '';
    acItems = [];
    acKind = null;
  }

  function acceptAutocomplete(i) {
    const item = acItems[i ?? acIndex];
    if (!item) return;
    const cursor = inputEl.selectionStart;
    const val = inputEl.value;
    const before = val.slice(0, cursor);
    const after = val.slice(cursor);
    if (acKind === 'file') {
      const newBefore = before.replace(/@[\w\-./\\]*$/, `@${item.label} `);
      inputEl.value = newBefore + after;
      inputEl.selectionStart = inputEl.selectionEnd = newBefore.length;
    } else {
      const newBefore = before.replace(/\/[\w:\-]*$/, `/${item.name} `);
      inputEl.value = newBefore + after;
      inputEl.selectionStart = inputEl.selectionEnd = newBefore.length;
    }
    hideAutocomplete();
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  }

  function checkAutocomplete() {
    const cursor = inputEl.selectionStart;
    const val = inputEl.value.slice(0, cursor);

    const fileMatch = val.match(/@([\w\-./\\]*)$/);
    if (fileMatch) {
      vscode.postMessage({ type: 'searchFile', query: fileMatch[1] });
      return;
    }

    const cmdMatch = val.match(/^\/([\w:\-]*)$/);
    if (cmdMatch && piCommands.length) {
      const q = cmdMatch[1].toLowerCase();
      const filtered = piCommands
        .filter(c => c.name.toLowerCase().includes(q))
        .slice(0, 10)
        .map(c => ({ name: c.name, label: `/${c.name}`, detail: c.description || c.source }));
      showAutocomplete(filtered, 'command');
      return;
    }
    hideAutocomplete();
  }

  function onInput() {
    // Avoid IPC unless the cursor is near @, /, or an open suggestion list.
    const ch = inputEl.value[inputEl.selectionStart - 1] || '';
    if (ch === '@' || ch === '/' || !autocompleteEl.classList.contains('hidden')) checkAutocomplete();
  }

  function handleKeydown(e) {
    if (autocompleteEl.classList.contains('hidden')) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; renderAutocomplete(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAutocomplete(); }
    else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptAutocomplete(); }
    else if (e.key === 'Escape') { e.preventDefault(); hideAutocomplete(); }
    else return false;
    return true;
  }

  function showFileResults(results) {
    const val = inputEl.value.slice(0, inputEl.selectionStart);
    if (/@[\w\-./\\]*$/.test(val)) {
      showAutocomplete(results.map(r => ({ label: r.label, path: r.path })), 'file');
    }
  }

  inputEl.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));

  return { onInput, handleKeydown, showFileResults, hide: hideAutocomplete, setCommands: commands => { piCommands = commands || []; } };
}
