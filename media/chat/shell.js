import { $, createElement, escapeHtml } from './dom.js';

export function createShell(vscode) {
  const state = { style: vscode.getState()?.style || 'custom' };
  const styleLink = $('chat-style');
  const btnStyle = $('btn-style');
  const btnKey = $('btn-key');
  const btnKeys = $('btn-keys');
  const btnNew = $('btn-new');
  const btnHistory = $('btn-history');
  const btnCloseSessions = $('btn-close-sessions');
  const sessionsPanel = $('sessions-panel');
  const sessionsList = $('sessions-list');
  const sessionNameEl = $('session-name');
  const sessionIdEl = $('session-id');
  const sessionHeader = $('session-header');
  const modelNameEl = $('model-name');
  const btnModel = $('btn-model');
  const btnThinking = $('btn-thinking');
  const thinkingLevelEl = $('thinking-level');
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  function applyStyle(style) {
    // Only use bundled stylesheet URLs supplied by the extension host.
    state.style = style === 'default' ? 'default' : 'custom';
    const uri = styleLink?.dataset[state.style];
    if (uri && styleLink.getAttribute('href') !== uri) styleLink.href = uri;
    if (btnStyle) {
      const label = state.style === 'default' ? 'Default' : 'Custom';
      btnStyle.title = `Chat style: ${label} — select style`;
      btnStyle.setAttribute('aria-label', `Select chat style (current: ${label})`);
    }
  }

  let _saveTimer = null;
  function saveState() {
    if (_saveTimer) return; // debounce — skip if already pending
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      vscode.setState({ style: state.style });
    }, 100);
  }

  // Session identity always comes from live RPC state, never persisted webview HTML.
  function renderSession(name, id) {
    const label = name || id || '';
    sessionNameEl.textContent = name || id || '';
    const showId = !!(name && id);
    sessionIdEl.textContent = id || '';
    sessionIdEl.classList.toggle('hidden', !showId);
    sessionNameEl.title = name && id ? `${name}\nSession ID: ${id}` : label;
    sessionHeader.classList.toggle('hidden', !label);
  }

  function renderSessions(msg) {
    sessionsList.innerHTML = '';
    if (msg.sessions && msg.sessions.length > 0) {
      sessionsPanel.classList.remove('hidden');
      msg.sessions.forEach(sess => {
        const item = createElement('div', 'session-item');
        item.title = sess.title;
        item.innerHTML = `
          <div class="session-item-title">${escapeHtml(sess.title)}</div>
          <div class="session-item-date">${escapeHtml(sess.date)}</div>`;
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'resumeSession', filePath: sess.filePath });
          sessionsPanel.classList.add('hidden');
        });
        sessionsList.appendChild(item);
      });
    } else {
      sessionsList.innerHTML = '<div class="sessions-empty">No sessions for this workspace yet</div>';
      sessionsPanel.classList.remove('hidden');
    }
  }

  function updateModel(msg) {
    if (msg.model) {
      const short = msg.model.split('/').pop();
      modelNameEl.textContent = short.length > 24 ? short.slice(0, 24) + '…' : short;
      modelNameEl.title = msg.model;
    }
    btnThinking.classList.toggle('hidden', !msg.modelReasoning);
    thinkingLevelEl.textContent = msg.thinkingLevel || 'off';
  }

  btnNew.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  btnHistory.addEventListener('click', () => {
    if (sessionsPanel.classList.contains('hidden')) {
      vscode.postMessage({ type: 'getSessions' });
    } else {
      sessionsPanel.classList.add('hidden');
    }
  });
  btnCloseSessions.addEventListener('click', () => sessionsPanel.classList.add('hidden'));

  btnModel.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
  btnThinking.addEventListener('click', () => {
    const cur = thinkingLevelEl.textContent;
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(cur) + 1) % THINKING_LEVELS.length];
    thinkingLevelEl.textContent = next;
    vscode.postMessage({ type: 'setThinkingLevel', level: next });
  });

  if (btnKey) btnKey.addEventListener('click', () => vscode.postMessage({ type: 'configureProvider' }));
  if (btnKeys) btnKeys.addEventListener('click', () => vscode.postMessage({ type: 'configureProvider' }));
  if (btnStyle) btnStyle.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectStyle', currentStyle: state.style });
  });

  applyStyle(state.style);

  return { applyStyle, saveState, renderSession, renderSessions, updateModel };
}
