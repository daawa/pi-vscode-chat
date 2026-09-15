import { $, createElement } from './dom.js';
import { ICONS } from './icons.js';
import { imagePreview } from './images.js';
import { createStreamingRenderer, highlightAll } from './markdown.js';
import { createToolCards, setToolState } from './tools.js';
import { createHistoryRenderer } from './history.js';

export function createConversation({ vscode, state, saveState }) {
  const messagesEl = $('messages');
  const inputEl = $('input');
  const { throttledRender, flushRender } = createStreamingRenderer();
  let autoScroll = true;
  messagesEl.addEventListener('scroll', () => {
    autoScroll = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  });
  function scrollToBottom(force) {
    if (!autoScroll && !force) return;
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  // ── Welcome state ──

  function renderWelcome() {
    if (messagesEl.querySelector('.message')) return;
    messagesEl.innerHTML = `
      <div id="welcome">
        <div class="welcome-logo">${ICONS.sparkle}</div>
        <h2>Pi Chat</h2>
        <p>Your local pi coding agent — with all its extensions, skills and models.</p>
        <div class="welcome-hints">
          <button class="hint" data-hint="Explain the architecture of this project">Explain this project</button>
          <button class="hint" data-hint="Find and fix bugs in the file I have open">Fix a bug</button>
          <button class="hint" data-hint="/">Browse / commands</button>
        </div>
      </div>`;
    messagesEl.querySelectorAll('.hint').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.hint;
      inputEl.value = v;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input'));
    }));
  }

  function clearWelcome() {
    const w = $('welcome');
    if (w) w.remove();
  }

  // ── Messages ──

  function getOrCreateMessage(role) {
    if (state.currentMessageId && role === 'assistant') {
      const existing = document.querySelector(`[data-msg-id="${state.currentMessageId}"]`);
      if (existing) return existing;
    }
    clearWelcome();

    const id = `msg-${++state.messageIdCounter}`;
    if (role === 'assistant') {
      state.currentMessageId = id;
      state.accumulatedText = '';
    }

    const msg = createElement('div', `message ${role}`);
    msg.dataset.msgId = id;

    if (role === 'assistant') {
      const header = createElement('div', 'message-header', `${ICONS.sparkle}<span>Pi</span>`);
      msg.appendChild(header);
    }
    msg.appendChild(createElement('div', 'message-content'));

    messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function addUserMessage(text, queued, images = [], submissionId) {
    clearWelcome();
    const msg = createElement('div', `message user${queued ? ' queued' : ''}`);
    const content = createElement('div', 'message-content');
    content.textContent = text;
    if (submissionId) msg.dataset.submissionId = submissionId;
    if (images.length) {
      const gallery = createElement('div', 'message-images');
      images.forEach(image => {
        const img = imagePreview(image, 'message-image');
        if (img) gallery.appendChild(img);
        else {
          const fallback = createElement('div', 'image-preview-unavailable');
          fallback.textContent = 'Image preview unavailable (unsupported format or size)';
          gallery.appendChild(fallback);
        }
      });
      content.appendChild(gallery);
    }
    msg.appendChild(content);
    if (queued) {
      msg.appendChild(createElement('div', 'queued-tag', 'queued'));
    }
    messagesEl.appendChild(msg);
    scrollToBottom(true);
    saveState();
  }

  // ── Thinking ──

  function appendThinkingDelta(messageId, blockIndex, delta) {
    const msgEl = document.querySelector(`[data-msg-id="${messageId === 'current' ? state.currentMessageId : messageId}"]`) || getOrCreateMessage('assistant');
    const contentEl = msgEl.querySelector('.message-content');

    let blockEl = contentEl.querySelector(`.thinking-block[data-block-idx="${blockIndex}"]`);
    if (!blockEl) {
      blockEl = createElement('details', 'thinking-block');
      blockEl.dataset.blockIdx = blockIndex;
      blockEl.innerHTML = `<summary>${ICONS.chevron}<span class="thinking-label">Thinking…</span><span class="shimmer"></span></summary><div class="thinking-content"></div>`;
      contentEl.appendChild(blockEl);
    }
    blockEl.querySelector('.thinking-content').textContent += delta;
    scrollToBottom();
  }

  function endThinking(messageId, blockIndex, content) {
    const msgEl = document.querySelector(`[data-msg-id="${messageId === 'current' ? state.currentMessageId : messageId}"]`);
    if (!msgEl) return;
    const blockEl = msgEl.querySelector(`.thinking-block[data-block-idx="${blockIndex}"]`);
    if (blockEl) {
      if (content) blockEl.querySelector('.thinking-content').textContent = content;
      blockEl.open = false;
      const label = blockEl.querySelector('.thinking-label');
      if (label) label.textContent = 'Thought';
      const shimmer = blockEl.querySelector('.shimmer');
      if (shimmer) shimmer.remove();
    }
    saveState();
  }

  function showError(message) {
    clearWelcome();
    const el = createElement('div', 'error-banner');
    el.textContent = message;
    messagesEl.appendChild(el);
    scrollToBottom(true);
  }

  function appendTextDelta(msg) {
    const msgEl = document.querySelector(`[data-msg-id="${msg.messageId === 'current' ? state.currentMessageId : msg.messageId}"]`) || getOrCreateMessage('assistant');
    const contentEl = msgEl.querySelector('.message-content');
    // Continue the last text block only if it is still the last child;
    // otherwise (tool/edit card interleaved) start a fresh block.
    let textEl = contentEl.lastElementChild;
    if (!textEl || !textEl.classList.contains('streaming-text')) {
      if (contentEl.querySelector('.streaming-text')) state.accumulatedText = '';
      textEl = createElement('div', 'streaming-text');
      contentEl.appendChild(textEl);
    }
    state.accumulatedText += msg.delta;
    throttledRender(textEl, state.accumulatedText);
    textEl.classList.add('live');
    scrollToBottom();
  }

  function beginTurn() {
    state.currentMessageId = null;
    state.accumulatedText = '';
  }

  function endTurn() {
    flushRender();
    document.querySelectorAll('.streaming-text').forEach(el => {
      el.classList.remove('live');
      highlightAll(el);
    });
    // Missing tool results mean interrupted, not failed.
    document.querySelectorAll('.tool-card.running').forEach(card => setToolState(card, 'interrupted'));
    saveState();
  }

  function clear() {
    messagesEl.innerHTML = '';
    tools.renderChangesBar([]);
    beginTurn();
    saveState();
    renderWelcome();
  }

  function removeRejectedMessage(submissionId) {
    document.querySelectorAll('.message.user').forEach(el => {
      if (el.dataset.submissionId === submissionId) el.remove();
    });
  }

  const tools = createToolCards({ vscode, state, getOrCreateMessage, scrollToBottom, saveState });
  const { renderHistory } = createHistoryRenderer({ messagesEl, state, addUserMessage, renderWelcome, scrollToBottom, saveState });

  return { tools, addUserMessage, renderHistory, renderWelcome, showError, appendTextDelta, appendThinkingDelta, endThinking, beginTurn, endTurn, clear, removeRejectedMessage, enableAutoScroll: () => { autoScroll = true; } };
}
