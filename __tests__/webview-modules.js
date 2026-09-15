// Controller integration checks, run against the same bundle shipped to VS Code.
(() => {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
  const input = document.getElementById('input');
  const button = document.getElementById('btn-send');
  const type = value => {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input'));
  };
  const key = value => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  const reset = () => {
    send({ type: 'sessionCleared' });
    send({ type: 'init', state: 'idle', modelSupportsImages: true });
    send({ type: 'historyLoading', loading: false });
    testPostedMessages.length = 0;
  };
  const test = (name, fn) => {
    reset();
    fn();
    assert(!testErrors.length, testErrors.join('; '));
    passed.push(name);
  };

  test('streamed text, thinking, tool cards and later text preserve conversation order', () => {
    send({ type: 'agentStart' });
    send({ type: 'textDelta', messageId: 'current', delta: '**First** `src/main.ts:12`' });
    send({ type: 'thinkingDelta', messageId: 'current', blockIndex: 1, delta: 'Reasoning' });
    send({ type: 'thinkingEnd', messageId: 'current', blockIndex: 1, content: 'Finished reasoning' });
    send({ type: 'agentEnd' }); // Flush throttled text deterministically.
    send({ type: 'toolStart', messageId: 'current', toolCallId: 'ordered', toolName: 'read', args: '{}' });
    send({ type: 'toolEnd', toolCallId: 'ordered', isError: false, output: 'ok' });
    send({ type: 'textDelta', messageId: 'current', delta: '**Second**' });
    send({ type: 'agentEnd' });
    const content = document.querySelector('.message.assistant .message-content');
    assert(content.children.length === 4, 'Interleaved blocks were lost');
    assert(content.children[0].querySelector('strong').textContent === 'First', 'Initial markdown missing');
    assert(content.children[1].querySelector('.thinking-content').textContent === 'Finished reasoning', 'Thinking not settled');
    assert(content.children[2].id === 'tool-ordered', 'Tool ordering changed');
    assert(content.children[3].querySelector('strong').textContent === 'Second', 'Later text overwrote earlier block');
    content.querySelector('.file-ref').click();
    assert(testPostedMessages.at(-1).type === 'openFile' && testPostedMessages.at(-1).line === 12, 'File reference delegation broken');
  });

  test('slash autocomplete selects a command without accidentally submitting it', () => {
    send({ type: 'commands', commands: [{ name: 'review', source: 'prompt' }, { name: 'resume', source: 'extension' }] });
    type('/');
    assert(document.querySelectorAll('.ac-item').length === 2, 'Command suggestions missing');
    key('ArrowDown');
    key('Enter');
    assert(input.value === '/resume ', 'Wrong selected command');
    assert(!testPostedMessages.some(m => m.type === 'prompt'), 'Autocomplete Enter submitted prompt');
  });

  test('file autocomplete routes host results and ignores stale replies', () => {
    type('@');
    assert(testPostedMessages.at(-1).type === 'searchFile', 'File search not requested');
    send({ type: 'fileResults', results: [{ label: 'src/main.ts', path: '/workspace/src/main.ts' }] });
    key('Tab');
    assert(input.value === '@src/main.ts ', 'File suggestion not inserted');
    type('ordinary text');
    send({ type: 'fileResults', results: [{ label: 'stale.ts', path: '/stale.ts' }] });
    assert(document.getElementById('autocomplete').classList.contains('hidden'), 'Stale file reply reopened suggestions');
  });

  test('status chips respect the composer lock and reset with the session', () => {
    send({ type: 'extensionUiRequest', method: 'setStatus', data: { statusKey: 'pi-rtk', statusText: 'enabled' } });
    const chip = document.querySelector('#status-bar button');
    assert(chip, 'Status chip not rendered');
    send({ type: 'historyLoading', loading: true });
    chip.click();
    assert(!testPostedMessages.length, 'Status chip bypassed history lock');
    send({ type: 'historyLoading', loading: false });
    chip.click();
    assert(testPostedMessages.at(-1).command === '/rtk disable', 'Status action not routed');
    send({ type: 'sessionCleared' });
    assert(document.getElementById('status-bar').classList.contains('hidden'), 'Status state survived clear');
  });

  test('team widgets, generic widgets, queue and stats are routed to their panels', () => {
    send({ type: 'extensionUiRequest', method: 'setStatus', data: { statusKey: 'worker', statusText: 'Working' } });
    send({ type: 'extensionUiRequest', method: 'setWidget', data: { widgetKey: 'worker', widgetLines: ['Reading source'] } });
    assert(document.getElementById('team-grid').textContent.includes('Reading source'), 'Team detail missing');
    send({ type: 'extensionUiRequest', method: 'setWidget', data: { widgetKey: 'Notes', widgetLines: ['<literal>'] } });
    assert(document.getElementById('widgets-container').textContent.includes('<literal>'), 'Widget content missing');
    send({ type: 'queueUpdate', steering: ['First'], followUp: ['Later'] });
    assert(document.querySelectorAll('.queue-chip').length === 2, 'Queue missing');
    send({ type: 'stats', stats: { contextUsage: { percent: 83 }, cost: 0.123, tokens: { total: 2000 } } });
    assert(document.getElementById('footer-stats').textContent.includes('83% context'), 'Stats missing');
    send({ type: 'sessionCleared' });
    assert(!document.querySelectorAll('.queue-chip, .agent-card, .widget-card').length, 'Panel state leaked between sessions');
  });

  test('extension dialogs preserve selection, confirmation, text and cancellation responses', () => {
    const dialog = (id, method, data = {}) => send({ type: 'extensionUiRequest', id, method, data });
    dialog('select', 'select', { title: 'Pick', options: ['One', 'Two'] });
    document.querySelectorAll('.dialog-option')[1].click();
    assert(testPostedMessages.at(-1).value === 'Two', 'Selection response missing');
    dialog('confirm', 'confirm', { message: 'Continue?' });
    document.querySelector('.dialog-btn.primary').click();
    assert(testPostedMessages.at(-1).confirmed === true, 'Confirmation response missing');
    dialog('input', 'input', { placeholder: 'Name' });
    document.querySelector('.dialog-input').value = 'Result';
    document.querySelector('.dialog-btn.primary').click();
    assert(testPostedMessages.at(-1).value === 'Result', 'Input response missing');
    dialog('editor', 'editor', { prefill: 'Original' });
    assert(document.querySelector('textarea.dialog-input').value === 'Original', 'Editor prefill missing');
    document.querySelector('.dialog-btn').click();
    assert(testPostedMessages.at(-1).cancelled === true, 'Cancel response missing');
  });

  test('shell toolbar, reasoning and session picker keep host message contracts', () => {
    send({ type: 'init', state: 'idle', model: 'provider/model', modelReasoning: true, thinkingLevel: 'low' });
    document.getElementById('btn-thinking').click();
    assert(testPostedMessages.at(-1).level === 'medium', 'Thinking did not cycle');
    document.getElementById('btn-model').click();
    assert(testPostedMessages.at(-1).type === 'selectModel', 'Model picker not routed');
    send({ type: 'sessionsList', sessions: [{ title: 'Session', date: 'Today', filePath: '/session.jsonl' }] });
    document.querySelector('.session-item').click();
    assert(testPostedMessages.at(-1).type === 'resumeSession', 'Session resume not routed');
    assert(document.getElementById('sessions-panel').classList.contains('hidden'), 'Session picker did not close');
  });

  test('plain file references flow from attachment controller into the submitted prompt', () => {
    document.getElementById('btn-attach').click();
    const requestId = testPostedMessages.at(-1).requestId;
    send({ type: 'attachmentsSelected', requestId, errors: [], attachments: [
      { id: 'file:///workspace/a.ts', type: 'file', name: 'a.ts', path: '/workspace/a.ts' },
    ] });
    type('Review');
    button.click();
    const prompt = testPostedMessages.at(-1);
    assert(prompt.type === 'prompt' && prompt.text === 'Review\n\n@/workspace/a.ts', 'File reference serialization changed');
    assert(prompt.images.length === 0, 'Plain file became an image');
  });

  reset();
  return passed;
})()
