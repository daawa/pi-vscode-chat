import { cleanAnsi, escapeHtml, createElement } from './dom.js';
import { ICONS } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { toolIcon, toolSubject, setToolState, renderInlineDiff } from './tools.js';

export function createHistoryRenderer({ messagesEl, state, addUserMessage, renderWelcome, scrollToBottom, saveState }) {

  function renderHistory(messages) {
    messagesEl.innerHTML = '';
    state.currentMessageId = null;
    const toolCards = {};
    const EDIT_TOOLS = new Set(['edit', 'write', 'multi-edit']);

    messages.forEach((m) => {
      if (!m || !m.role) return;
      if (m.role === 'user') {
        const text = Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text || '').join('') : String(m.content ?? '');
        const images = Array.isArray(m.content) ? m.content.filter(c => c.type === 'image') : [];
        if (text.trim() || images.length) addUserMessage(text.trim(), false, images);
      } else if (m.role === 'assistant') {
        const msgEl = createElement('div', 'message assistant');
        msgEl.appendChild(createElement('div', 'message-header', `${ICONS.sparkle}<span>Pi</span>`));
        const contentEl = createElement('div', 'message-content');
        msgEl.appendChild(contentEl);
        messagesEl.appendChild(msgEl);

        const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
        content.forEach((item, idx) => {
          if (item.type === 'thinking' && item.thinking) {
            const blockEl = createElement('details', 'thinking-block');
            blockEl.dataset.blockIdx = idx;
            blockEl.innerHTML = `<summary>${ICONS.chevron}<span class="thinking-label">Thought</span></summary><div class="thinking-content">${escapeHtml(item.thinking)}</div>`;
            contentEl.appendChild(blockEl);
          } else if (item.type === 'text' && item.text) {
            const textEl = createElement('div', 'streaming-text');
            renderMarkdown(textEl, item.text);
            contentEl.appendChild(textEl);
          } else if (item.type === 'toolCall') {
            const subject = toolSubject(item.name, item.arguments);
            const card = createElement('details', 'tool-card');
            card.id = `tool-${item.id}`;
            card.innerHTML = `
              <summary>
                <span class="tool-status"></span>
                <span class="tool-icon">${toolIcon(item.name)}</span>
                <span class="tool-name">${escapeHtml(item.name)}</span>
                <span class="tool-subject">${escapeHtml(subject)}</span>
                ${ICONS.chevron}
              </summary>
              <div class="tool-body">
                <pre class="tool-args"><code>${escapeHtml(JSON.stringify(item.arguments ?? {}, null, 2))}</code></pre>
                <pre class="tool-output hidden"><code></code></pre>
              </div>`;
            setToolState(card, 'unknown');
            contentEl.appendChild(card);
            toolCards[item.id] = { card, name: item.name, args: item.arguments };
          }
        });
      } else if (m.role === 'toolResult' && toolCards[m.toolCallId]) {
        const entry = toolCards[m.toolCallId];
        const card = entry.card;
        setToolState(card, m.isError ? 'error' : 'done');
        const text = (m.content || []).map(c => c.text || '').join('');
        if (text) {
          const out = card.querySelector('.tool-output');
          out.classList.remove('hidden');
          out.querySelector('code').textContent = cleanAnsi(text).slice(0, 8000);
        }
        const diff = m.details?.diff || m.details?.patch;
        const relFilePath = entry.args?.path || entry.args?.file_path || entry.args?.filePath;
        if (!m.isError && diff && relFilePath && EDIT_TOOLS.has(entry.name)) {
          renderInlineDiff(card, relFilePath, '', String(diff));
        }
      } else if (m.role === 'compactionSummary' || m.role === 'branchSummary') {
        const isCompaction = m.role === 'compactionSummary';
        const msgEl = createElement('div', 'message assistant');
        msgEl.appendChild(createElement('div', 'message-header', `${ICONS.sparkle}<span>Pi</span>`));
        const contentEl = createElement('div', 'message-content');
        const card = createElement('details', 'tool-card summary-card');
        card.open = true;
        card.innerHTML = `
          <summary>
            <span class="tool-icon">${ICONS.check}</span>
            <span class="tool-name">${escapeHtml(isCompaction ? 'Context compacted' : 'Branch summary')}</span>
            ${ICONS.chevron}
          </summary>
          <div class="tool-body"><div class="summary-text"></div></div>`;
        renderMarkdown(card.querySelector('.summary-text'), m.summary || '');
        contentEl.appendChild(card);
        msgEl.appendChild(contentEl);
        messagesEl.appendChild(msgEl);
      }
    });
    if (!messagesEl.querySelector('.message')) renderWelcome();
    scrollToBottom(true);
    saveState();
  }

  return { renderHistory };
}
