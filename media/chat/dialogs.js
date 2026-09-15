import { $, createElement } from './dom.js';

export function createDialogs(vscode) {
  const dialogOverlay = $('dialog-overlay');
  function showDialog(request) {
    const { id, method } = request;
    dialogOverlay.classList.remove('hidden');
    dialogOverlay.innerHTML = '';

    const box = createElement('div', 'dialog');
    const title = createElement('div', 'dialog-title');
    title.textContent = request.data.title || 'Pi';
    box.appendChild(title);

    const respond = (payload) => {
      dialogOverlay.classList.add('hidden');
      dialogOverlay.innerHTML = '';
      vscode.postMessage({ type: 'extensionUiResponse', id, ...payload });
    };

    if (method === 'select') {
      const list = createElement('div', 'dialog-options');
      (request.data.options || []).forEach(opt => {
        const b = createElement('button', 'dialog-option');
        b.textContent = opt;
        b.addEventListener('click', () => respond({ value: opt }));
        list.appendChild(b);
      });
      box.appendChild(list);
      box.appendChild(dialogButtons(null, () => respond({ cancelled: true })));
    } else if (method === 'confirm') {
      const msg = createElement('div', 'dialog-message');
      msg.textContent = request.data.message || '';
      box.appendChild(msg);
      box.appendChild(dialogButtons(
        { label: 'Yes', fn: () => respond({ confirmed: true }) },
        () => respond({ confirmed: false }),
        'No',
      ));
    } else if (method === 'input' || method === 'editor') {
      const field = createElement(method === 'editor' ? 'textarea' : 'input', 'dialog-input');
      if (method === 'editor') { field.rows = 8; field.value = request.data.prefill || ''; }
      else field.placeholder = request.data.placeholder || '';
      box.appendChild(field);
      box.appendChild(dialogButtons(
        { label: 'OK', fn: () => respond({ value: field.value }) },
        () => respond({ cancelled: true }),
      ));
      setTimeout(() => field.focus(), 50);
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && method === 'input') { e.preventDefault(); respond({ value: field.value }); }
        if (e.key === 'Escape') respond({ cancelled: true });
      });
    } else {
      // Unknown dialog method: cancel so pi never blocks
      respond({ cancelled: true });
      return;
    }

    dialogOverlay.appendChild(box);
  }

  function dialogButtons(primary, onCancel, cancelLabel) {
    const row = createElement('div', 'dialog-buttons');
    const cancel = createElement('button', 'dialog-btn');
    cancel.textContent = cancelLabel || 'Cancel';
    cancel.addEventListener('click', onCancel);
    row.appendChild(cancel);
    if (primary) {
      const ok = createElement('button', 'dialog-btn primary');
      ok.textContent = primary.label;
      ok.addEventListener('click', primary.fn);
      row.appendChild(ok);
    }
    return row;
  }

  return { showDialog };
}
