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
        <h2>Pi</h2>
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

    // Pending input is not part of the delivered transcript yet. In particular,
    // a follow-up sent before the first delta must stay BELOW the current reply.
    messagesEl.insertBefore(msg, messagesEl.querySelector('.message.user.queued'));
    scrollToBottom();
    return msg;
  }

  function addUserMessage(text, queued, images = [], submissionId, queueBehavior) {
    clearWelcome();
    const msg = createElement('div', `message user${queued ? ' queued' : ''}`);
    const content = createElement('div', 'message-content');
    content.textContent = text;
    if (submissionId) msg.dataset.submissionId = submissionId;
    // Queued bubbles stay "unconfirmed" until the host acknowledges the prompt
    // (promptResult queued:true); only confirmed bubbles are reconciled with
    // pi's queue, so an earlier queue_update can never settle a fresh bubble.
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
      msg.dataset.queueBehavior = queueBehavior === 'followUp' ? 'followUp' : 'steer';
      const isFollowUp = queueBehavior === 'followUp';
      const tag = createElement('div', `queued-tag ${isFollowUp ? 'tag-follow' : 'tag-steer'}`);
      tag.textContent = isFollowUp ? '⏭ queued · runs after this run' : '↪ steering · injected into current run';
      msg.appendChild(tag);
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
    // Only the block currently receiving deltas may show the streaming caret.
    document.querySelectorAll('.streaming-text.live').forEach(el => {
      if (el !== textEl) el.classList.remove('live');
    });
    state.accumulatedText += msg.delta;
    throttledRender(textEl, state.accumulatedText);
    textEl.classList.add('live');
    scrollToBottom();
  }

  function beginTurn() {
    state.currentMessageId = null;
    state.accumulatedText = '';
  }

  /** A new assistant turn started. A steer delivered between turns inserts a user
   *  message after the current assistant bubble; the reply to it must render in a
   *  fresh bubble BELOW that message, not continue the old bubble above it.
   *  Still-queued bubbles are ignored: their message has not been delivered yet.
   *  Plain tool-loop turns (no interleaved delivered user message) keep the bubble. */
  function handleTurnStart() {
    const current = state.currentMessageId ? document.querySelector(`[data-msg-id="${state.currentMessageId}"]`) : null;
    if (!current) return; // no bubble yet — the next delta appends at the bottom anyway
    const siblings = Array.from(messagesEl.children);
    const userDelivered = siblings.slice(siblings.indexOf(current) + 1)
      .some(el => el.classList && el.classList.contains('user') && !el.classList.contains('queued'));
    if (userDelivered) {
      flushRender(); // settle the old bubble's pending streamed text first
      beginTurn();
    }
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

  // ── Queue reconciliation (pi queue_update / queueCleared) ──

  function settleQueuedBubble(el) {
    el.classList.remove('queued');
    delete el.dataset.queuedConfirmed;
    delete el.dataset.queueBehavior;
    // Consumption order can differ from submission order: a later steer may be
    // delivered before an earlier follow-up. Put delivered input before the queue.
    messagesEl.insertBefore(el, messagesEl.querySelector('.message.user.queued'));
    const tag = el.querySelector('.queued-tag');
    if (tag) tag.remove();
    saveState();
  }

  /** The prompt for this bubble was acknowledged as queued (disposition "queued"):
   *  from now on it is reconciled against pi's queue. */
  function confirmQueuedSubmission(submissionId) {
    const el = document.querySelector(`[data-submission-id="${submissionId}"]`);
    if (el && el.classList.contains('queued')) el.dataset.queuedConfirmed = 'true';
  }

  /** The prompt was acknowledged but never queued (e.g. it started a run because the
   *  streaming flag was stale): settle the bubble immediately instead of leaving it dashed. */
  function settleQueuedSubmission(submissionId) {
    const el = document.querySelector(`[data-submission-id="${submissionId}"]`);
    if (el && el.classList.contains('queued')) settleQueuedBubble(el);
  }

  /** Reconcile each queue independently: steering can overtake follow-ups.
   *  Within each queue, the newest confirmed bubbles are still pending. Compare
   *  counts, not text, because pi can expand templates and attachments. */
  function settleQueuedMessages(steering = [], followUp = []) {
    for (const [behavior, pending] of [['steer', steering], ['followUp', followUp]]) {
      const confirmed = [...messagesEl.querySelectorAll('.message.user.queued')]
        .filter(el => el.dataset.queuedConfirmed === 'true' && el.dataset.queueBehavior === behavior);
      confirmed.slice(0, Math.max(0, confirmed.length - (pending || []).length)).forEach(settleQueuedBubble);
    }
  }

  /** Remove the bubbles for messages dropped by clear_queue. A bubble that is both
   *  confirmed and still queued was in pi's queue when it was cleared, whatever text
   *  pi stored for it; their text returns to the composer via setInputText. */
  function removeQueuedMessages() {
    [...document.querySelectorAll('.message.user.queued')]
      .filter(el => el.dataset.queuedConfirmed === 'true')
      .forEach(el => el.remove());
    saveState();
  }

  const tools = createToolCards({ vscode, state, getOrCreateMessage, scrollToBottom, saveState });
  const { renderHistory } = createHistoryRenderer({ messagesEl, state, addUserMessage, renderWelcome, scrollToBottom, saveState });

  return { tools, addUserMessage, renderHistory, renderWelcome, showError, appendTextDelta, appendThinkingDelta, endThinking, beginTurn, endTurn, handleTurnStart, clear, removeRejectedMessage, confirmQueuedSubmission, settleQueuedSubmission, settleQueuedMessages, removeQueuedMessages, enableAutoScroll: () => { autoScroll = true; } };
}
