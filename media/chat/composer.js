import { $, uniqueId } from './dom.js';
import { createAutocomplete } from './autocomplete.js';
import { createAttachments } from './attachments.js';
import { bindDropInput } from './drop-input.js';

export function createComposer({ vscode, state, showError, removeRejectedMessage, enableAutoScroll }) {
  const inputEl = $('input');
  const sendBtn = $('btn-send');
  const abortBtn = $('btn-abort');
  const btnAttach = $('btn-attach');
  const btnNew = $('btn-new');
  const btnHistory = $('btn-history');
  const btnModel = $('btn-model');
  let historyLoading = true;
  let pendingSubmission = null;
  let modelSupportsImages = false;
  const isLocked = () => historyLoading || !!pendingSubmission;
  const autocomplete = createAutocomplete({ vscode, inputEl });
  const attachments = createAttachments({ vscode, isLocked,
    isSubmitting: () => !!pendingSubmission, onChange: updateComposerState, showError });
  function canSubmit() {
    return !historyLoading && !pendingSubmission && !attachments.isReading() &&
      (!!inputEl.value.trim() || attachments.getItems().length > 0) &&
      (modelSupportsImages || !attachments.getItems().some(a => a.type === 'image'));
  }

  function updateComposerState() {
    const hasContent = !!inputEl.value.trim() || attachments.getItems().length > 0;
    const locked = historyLoading || !!pendingSubmission;
    const unsupported = attachments.getItems().some(a => a.type === 'image') && !modelSupportsImages;
    sendBtn.disabled = !canSubmit();
    sendBtn.classList.toggle('hidden', state.isStreaming && !hasContent);
    inputEl.readOnly = locked;
    btnAttach.disabled = locked;
    btnNew.disabled = !!pendingSubmission;
    btnHistory.disabled = !!pendingSubmission;
    btnModel.disabled = !!pendingSubmission;
    document.querySelectorAll('.attachment-chip button').forEach(button => { button.disabled = locked; });
    const status = $('attachment-status');
    status.textContent = pendingSubmission ? 'Submitting…' : attachments.isReading() ? 'Reading attachments…' : unsupported
      ? 'Select an image-capable model to send these attachments.' : '';
    status.classList.toggle('hidden', !status.textContent);
  }

  // ── Streaming state ──

  function updateStreamingState(isStreaming) {
    state.isStreaming = isStreaming;
    document.body.classList.toggle('streaming', isStreaming);
    abortBtn.classList.toggle('hidden', !isStreaming);
    updateComposerState();
    inputEl.placeholder = historyLoading
      ? 'Loading session history…'
      : isStreaming
        ? 'Steer the agent — Enter to send, Esc to stop'
        : 'Ask Pi — @ for files, / for commands';
  }

  function clearComposer() {
    pendingSubmission = null;
    inputEl.value = '';
    inputEl._lastLen = 0;
    inputEl.style.height = 'auto';
    attachments.clear();
    autocomplete.hide();
  }

  // ── Send ──

  function sendMessage() {
    if (!canSubmit()) return;
    const text = inputEl.value.trim();

    const wasStreaming = state.isStreaming;
    if (!wasStreaming) {
      state.currentMessageId = null;
      state.accumulatedText = '';
    }

    let formattedText = text;
    const images = [];
    attachments.getItems().forEach(att => {
      if (att.type === 'file') {
        formattedText += `\n\n@${att.path}`;
      } else if (att.type === 'image') {
        images.push({ data: att.data, mime: att.mime, name: att.name });
      } else if (att.type === 'textcontent') {
        formattedText += `\n\nAttached file "${att.name}":\n\`\`\`\n${att.content}\n\`\`\``;
      }
    });

    // Keep the exact draft until Pi acknowledges acceptance. Rejection merely
    // unlocks it, so images/text cannot be lost or overwritten by a new draft.
    pendingSubmission = uniqueId();
    autocomplete.hide();
    updateComposerState();
    enableAutoScroll();
    vscode.postMessage({ type: 'prompt', submissionId: pendingSubmission, text: formattedText, images, streaming: wasStreaming });
  }

  function handlePromptResult(msg) {
    if (pendingSubmission !== msg.submissionId) return;
    pendingSubmission = null;
    if (msg.success) clearComposer();
    else {
      removeRejectedMessage(msg.submissionId);
      showError(msg.error || 'Prompt rejected. Your draft has been preserved.');
      updateComposerState();
    }
    inputEl.focus();
  }

  function setInputText(text, append) {
    if (pendingSubmission) return;
    inputEl.value = append && inputEl.value ? inputEl.value + '\n' + text : text;
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  }

  function setModelSupportsImages(value) {
    modelSupportsImages = !!value;
    updateComposerState();
  }

  function setHistoryLoading(value) {
    historyLoading = value;
    updateStreamingState(state.isStreaming);
  }

  inputEl.addEventListener('input', () => {
    const v = inputEl.value;
    if (inputEl._lastLen !== v.length) {
      inputEl._lastLen = v.length;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    }
    updateComposerState();
    autocomplete.onInput();
  });

  inputEl.addEventListener('keydown', e => {
    if (autocomplete.handleKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape' && state.isStreaming) {
      e.preventDefault();
      vscode.postMessage({ type: 'abort' });
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  btnAttach.addEventListener('click', attachments.selectFiles);
  bindDropInput({ inputEl, attachments, isLocked });

  return { attachments, autocomplete, isLocked, updateStreamingState, clear: clearComposer, setInputText, setModelSupportsImages, setHistoryLoading, handlePromptResult };
}
