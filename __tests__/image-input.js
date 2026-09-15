// Evaluated by tool-states.py through browser-harness against the real webview.
(async () => {
  const passed = [];
  window.imageTestProgress = { passed, current: '' };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
  const input = document.getElementById('input');
  const button = document.getElementById('btn-send');
  const list = document.getElementById('attachment-list');
  const status = document.getElementById('attachment-status');
  const submissions = () => testPostedMessages.filter(m => m.type === 'prompt');
  const image = { type: 'image', mime: 'image/png', name: 'screenshot.png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
  const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
  const file = (name = 'screenshot.png') => new File([bytes], name, { type: 'image/png' });
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for attachment state: ' + status.textContent);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const loaded = () => wait(() => !status.textContent.includes('Reading'));
  const reset = () => {
    send({ type: 'sessionCleared' });
    send({ type: 'historyLoading', loading: false });
    send({ type: 'init', state: 'idle', modelSupportsImages: true });
    testPostedMessages.length = 0;
  };
  const paste = (files, text) => {
    const data = new DataTransfer();
    files.forEach(file => data.items.add(file));
    if (text) data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
  };
  const type = text => { input.value = text; input.dispatchEvent(new Event('input')); };
  const test = async (name, fn) => {
    window.imageTestProgress.current = name;
    reset();
    await fn();
    assert(!testErrors.length, testErrors.join('; '));
    passed.push(name);
  };

  await test('clipboard image-only send is gated during decoding and preserves the draft until acceptance', async () => {
    assert(paste([file()]).defaultPrevented, 'Image paste was not handled');
    assert(button.disabled && status.textContent.includes('Reading'), 'Send raced FileReader');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(!submissions().length, 'Incomplete image was submitted');
    await loaded();
    const thumbnail = list.querySelector('img');
    assert(thumbnail && thumbnail.naturalWidth === 1, 'Missing decoded thumbnail');
    assert(!button.disabled && !input.value, 'Image-only draft cannot send');
    button.click();
    const prompt = submissions()[0];
    assert(prompt.text === '' && prompt.images.length === 1, 'Image-only RPC payload missing');
    assert(prompt.images[0].data === image.data && prompt.images[0].mime === 'image/png', 'Wrong base64/MIME');
    assert(input.readOnly && button.disabled && list.querySelector('img'), 'Draft not retained during preflight');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(submissions().length === 1, 'Duplicate submission during preflight');
    send({ type: 'userMessage', text: '', images: prompt.images, submissionId: prompt.submissionId });
    assert(document.querySelector('.message.user img'), 'Live bubble dropped pixels');
    send({ type: 'promptResult', submissionId: 'obsolete-id', success: true });
    assert(list.querySelector('img'), 'Unrelated acknowledgment cleared draft');
    send({ type: 'promptResult', submissionId: prompt.submissionId, success: true });
    assert(!list.children.length && !input.readOnly && button.disabled, 'Acceptance did not clear and unlock');
  });

  await test('mixed clipboard text/images preserves selection insertion and ordinary text paste', async () => {
    type('before after');
    input.setSelectionRange(7, 7);
    paste([file()], 'caption ');
    await loaded();
    assert(input.value === 'before caption after', 'Mixed paste discarded text or selection');
    assert(!paste([], 'normal text').defaultPrevented, 'Text-only paste was intercepted');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true }));
    assert(list.children.length === 1, 'Missing clipboardData changed attachments');
  });

  await test('rejection restores the exact draft, removes its optimistic bubble, and permits retry', async () => {
    type('Describe this screenshot');
    paste([file()]);
    await loaded();
    button.click();
    const prompt = submissions()[0];
    send({ type: 'userMessage', text: prompt.text, images: prompt.images, submissionId: prompt.submissionId });
    send({ type: 'promptResult', submissionId: prompt.submissionId, success: false, error: 'Authentication required' });
    assert(input.value === prompt.text && list.querySelector('img'), 'Rejected draft was lost');
    assert(!input.readOnly && !button.disabled, 'Rejected draft remained locked');
    assert(!document.querySelector('.message.user'), 'Rejected bubble still looks accepted');
    assert(document.querySelector('.error-banner').textContent.includes('Authentication'), 'Missing rejection error');
    button.click();
    assert(submissions().length === 2 && submissions()[1].images[0].data === image.data, 'Retry lost the attachment');
  });

  await test('file picker returns images with names, deduplicates paths, and cancels cleanly', async () => {
    const pick = () => { document.getElementById('btn-attach').click(); return testPostedMessages.at(-1).requestId; };
    let requestId = pick();
    assert(button.disabled && status.textContent.includes('Reading'), 'Picker did not gate submission');
    send({ type: 'attachmentsSelected', requestId, attachments: [], errors: [] });
    await loaded();
    assert(!list.children.length, 'Cancelled picker created an attachment');
    requestId = pick();
    const attachment = { ...image, id: 'file:///a.png', name: '<b>Screenshot</b>.png' };
    send({ type: 'attachmentsSelected', requestId, attachments: [attachment, attachment], errors: [] });
    await loaded();
    assert(list.children.length === 1 && list.querySelector('img'), 'Picker did not deduplicate/render image');
    assert(list.textContent.includes('<b>Screenshot</b>') && !list.querySelector('b'), 'Filename rendered as HTML');
    list.querySelector('button').click();
    assert(!list.children.length && button.disabled, 'Remove did not update image-only send state');
  });

  await test('text-only model blocks image sends without losing attachments; switching enables steering', async () => {
    paste([file()]);
    await loaded();
    send({ type: 'init', state: 'streaming', modelSupportsImages: false });
    assert(button.disabled && status.textContent.includes('image-capable'), 'Non-vision model accepted image');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(!submissions().length && list.querySelector('img'), 'Capability failure lost/sent attachment');
    send({ type: 'init', state: 'streaming', modelSupportsImages: true });
    assert(!button.disabled && !button.classList.contains('hidden'), 'Image-only steering button hidden');
    button.click();
    assert(submissions()[0].streaming === true && submissions()[0].images.length === 1, 'Steering omitted image');
  });

  await test('restored history renders mixed and image-only user messages safely', async () => {
    send({ type: 'loadHistory', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Earlier screenshot' }, { type: 'image', data: image.data, mimeType: image.mime }] },
      { role: 'user', content: [{ type: 'image', data: image.data, mimeType: image.mime }] },
      { role: 'user', content: [{ type: 'image', data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }] },
    ] });
    const pictures = document.querySelectorAll('.message.user img');
    assert(pictures.length === 2, 'History dropped image-only messages or allowed SVG');
    assert(document.getElementById('messages').textContent.includes('Earlier screenshot'), 'History lost text');
    await pictures[0].decode();
    assert(pictures[0].naturalWidth === 1, 'History image not decodable');
  });

  await test('Explorer drops preserve remote URI authority for extension-host file reads', async () => {
    const uri = 'vscode-remote://ssh-remote+builder/home/me/a%20b.png';
    const data = new DataTransfer();
    data.setData('application/vnd.code.uri-list', uri);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, cancelable: true }));
    const request = testPostedMessages.at(-1);
    assert(request.type === 'attachFiles' && request.uris[0] === uri, 'Remote URI was reduced to a path');
    send({ type: 'attachmentsSelected', requestId: request.requestId, attachments: [{ ...image, id: uri }], errors: [] });
    await loaded();
    button.click();
    assert(submissions()[0].text === '' && submissions()[0].images.length === 1, 'Explorer image became @path text');
  });

  await test('OS drops read image bytes before URI or Electron file.path fallbacks', async () => {
    const data = new DataTransfer();
    const imageFile = file();
    Object.defineProperty(imageFile, 'path', { value: '/local/screenshot.png' });
    data.items.add(imageFile);
    data.setData('text/uri-list', 'file:///local/screenshot.png');
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, cancelable: true }));
    await loaded();
    assert(!testPostedMessages.some(m => m.type === 'attachFiles'), 'Local OS file was read on the remote host');
    assert(list.querySelector('img'), 'OS image drop missing preview');
    button.click();
    assert(submissions()[0].images[0].data === image.data, 'OS image bytes changed');
  });

  await test('unsupported, corrupt, oversized, and excessive-count clipboard images report errors', async () => {
    paste([new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' })]);
    await loaded();
    paste([new File(['not an image'], 'bad.png', { type: 'image/png' })]);
    await loaded();
    paste([new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })]);
    await loaded();
    assert(!list.children.length && document.querySelectorAll('.error-banner').length === 3, 'Invalid images were accepted or silently dropped');
    for (let i = 0; i < 5; i++) { paste([file()]); await loaded(); }
    assert(list.children.length === 4, 'Image count limit not enforced');
    assert(document.getElementById('messages').textContent.includes('at most 4 images'), 'Missing count-limit error');
  });

  await test('session changes invalidate late clipboard and file-picker reads', async () => {
    document.getElementById('btn-attach').click();
    const requestId = testPostedMessages.at(-1).requestId;
    send({ type: 'clearComposer' });
    send({ type: 'attachmentsSelected', requestId, attachments: [{ ...image, id: 'late' }], errors: [] });
    await loaded();
    assert(!list.children.length, 'Stale picker leaked into another session');
    const NativeReader = window.FileReader;
    let release;
    try {
      window.FileReader = class extends NativeReader {
        readAsDataURL(file) { release = () => super.readAsDataURL(file); }
      };
      paste([file()]);
      assert(button.disabled && release, 'Delayed read was not tracked');
      send({ type: 'sessionCleared' });
      release();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert(!list.children.length && button.disabled, 'Stale clipboard read leaked into new session');
    } finally { window.FileReader = NativeReader; }
  });

  await test('JPEG and WebP clipboard images retain actual MIME instead of forced PNG', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    for (const mime of ['image/jpeg', 'image/webp']) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, mime));
      paste([new File([blob], 'image.' + mime.split('/')[1], { type: mime })]);
      await loaded();
    }
    button.click();
    assert(submissions()[0].images.map(i => i.mime).join(',') === 'image/jpeg,image/webp', 'MIME types were changed');
  });

  reset();
  return passed;
})()
