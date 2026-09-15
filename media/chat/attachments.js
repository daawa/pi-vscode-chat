import { $, createElement, uniqueId } from './dom.js';
import { ICONS } from './icons.js';
import { IMAGE_LIMITS, IMAGE_MIMES, imagePreview, imageBytes, readFile } from './images.js';

export function createAttachments({ vscode, isLocked, isSubmitting, onChange, showError }) {
  let attachments = [];
  const pendingAttachmentReads = new Set();
  function addAttachment(file) {
    if (isSubmitting()) return;
    file.id ||= file.path || uniqueId();
    if (attachments.some(a => a.id === file.id)) return;
    if (file.type === 'image') {
      const images = attachments.filter(a => a.type === 'image');
      if (images.length >= IMAGE_LIMITS.count) throw new Error('Attach at most 4 images per message.');
      if (images.reduce((sum, image) => sum + imageBytes(image), imageBytes(file)) > IMAGE_LIMITS.totalBytes) {
        throw new Error('Images must total at most 12 MiB per message.');
      }
    }
    attachments.push(file);
    renderAttachments();
  }

  function removeAttachment(id) {
    if (isSubmitting()) return;
    attachments = attachments.filter(a => a.id !== id);
    renderAttachments();
  }

  function renderAttachments() {
    const list = $('attachment-list');
    list.innerHTML = '';
    attachments.forEach(att => {
      const chip = createElement('div', `attachment-chip${att.type === 'image' ? ' image-attachment' : ''}`);
      chip.innerHTML = `${ICONS.file}<span></span><button title="Remove" aria-label="Remove attachment">✕</button>`;
      const label = chip.querySelector('span');
      label.textContent = att.name;
      label.title = att.path || att.name;
      if (att.type === 'image') {
        const img = imagePreview(att, 'attachment-thumbnail');
        if (img) chip.replaceChild(img, chip.firstElementChild);
      }
      const remove = chip.querySelector('button');
      remove.disabled = !!isSubmitting();
      remove.addEventListener('click', () => removeAttachment(att.id));
      list.appendChild(chip);
    });
    onChange();
  }

  function beginAttachmentRead() {
    const id = uniqueId();
    pendingAttachmentReads.add(id);
    onChange();
    return id;
  }

  async function prepareImage(image, requestId) {
    if (!IMAGE_MIMES.has(image.mime)) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
    if (!image.data || imageBytes(image) > IMAGE_LIMITS.bytes) throw new Error('Images must be non-empty and at most 4 MiB each.');
    const preview = imagePreview(image, '');
    if (!preview) throw new Error('Invalid image.');
    // Validation uses a detached image: lazy loading would wait forever for it
    // to enter the viewport. Only message-history thumbnails should be lazy.
    preview.loading = 'eager';
    await preview.decode();
    if (preview.naturalWidth > IMAGE_LIMITS.dimension || preview.naturalHeight > IMAGE_LIMITS.dimension ||
        preview.naturalWidth * preview.naturalHeight > IMAGE_LIMITS.pixels) {
      throw new Error('Image exceeds 8000 pixels per side or 32 megapixels. Resize it and retry.');
    }
    if (pendingAttachmentReads.has(requestId)) addAttachment(image);
  }

  async function receiveAttachments(msg) {
    if (!pendingAttachmentReads.has(msg.requestId)) return;
    try {
      for (const attachment of msg.attachments || []) {
        if (!pendingAttachmentReads.has(msg.requestId)) break;
        try {
          if (attachment.type === 'image') await prepareImage(attachment, msg.requestId);
          else addAttachment(attachment);
        } catch (err) { if (pendingAttachmentReads.has(msg.requestId)) showError(`Cannot attach ${attachment.name}: ${err}`); }
      }
      if (pendingAttachmentReads.has(msg.requestId)) (msg.errors || []).forEach(showError);
    } finally {
      pendingAttachmentReads.delete(msg.requestId);
      onChange();
    }
  }

  async function attachImageFile(file) {
    if (isLocked()) return;
    if (pendingAttachmentReads.size >= IMAGE_LIMITS.count) {
      showError('Wait for the current attachments to finish loading.');
      return;
    }
    const requestId = beginAttachmentRead();
    try {
      if (!file.size || file.size > IMAGE_LIMITS.bytes) throw new Error('Images must be non-empty and at most 4 MiB each.');
      // Some OS drops omit MIME; infer only a candidate here. The host checks bytes.
      const extension = file.name.split('.').pop().toLowerCase();
      const inferredMime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[extension];
      const mime = !file.type || file.type === 'application/octet-stream' ? inferredMime : file.type;
      if (!IMAGE_MIMES.has(mime)) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
      const dataUrl = await readFile(file);
      if (!pendingAttachmentReads.has(requestId)) return;
      await prepareImage({ id: uniqueId(), type: 'image', name: file.name || `pasted-image.${mime.split('/')[1]}`,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1), mime }, requestId);
    } catch (err) {
      if (pendingAttachmentReads.has(requestId)) showError(`Cannot attach image: ${err}`);
    } finally {
      pendingAttachmentReads.delete(requestId);
      onChange();
    }
  }

  async function attachTextFile(file) {
    const requestId = beginAttachmentRead();
    try {
      if (file.size > 256 * 1024) throw new Error('Dropped text files must be at most 256 KiB. Use the file picker for a path reference.');
      const content = await readFile(file, true);
      if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) throw new Error('Unsupported binary file.');
      if (pendingAttachmentReads.has(requestId)) {
        addAttachment({ id: uniqueId(), name: file.name, content: content.slice(0, 64 * 1024), type: 'textcontent' });
      }
    } catch (err) {
      if (pendingAttachmentReads.has(requestId)) showError(`Cannot attach ${file.name}: ${err}`);
    } finally {
      pendingAttachmentReads.delete(requestId);
      onChange();
    }
  }

  function clear() {
    pendingAttachmentReads.clear(); // Ignore late reads from the previous draft/session.
    attachments = [];
    renderAttachments();
  }

  function selectFiles() {
    if (isLocked()) return;
    vscode.postMessage({ type: 'selectFileToAttach', requestId: beginAttachmentRead() });
  }

  function attachUris(uris) {
    vscode.postMessage({ type: 'attachFiles', requestId: beginAttachmentRead(), uris });
  }

  return { clear, selectFiles, attachUris, receiveAttachments, attachImageFile, attachTextFile, getItems: () => attachments, isReading: () => pendingAttachmentReads.size > 0 };
}
