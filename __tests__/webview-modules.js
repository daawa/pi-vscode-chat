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

  test('thinking cycles within the levels the current model supports', () => {
    send({ type: 'init', state: 'idle', model: 'provider/model', modelReasoning: true, thinkingLevel: 'low', thinkingLevels: ['off', 'low', 'high'] });
    document.getElementById('btn-thinking').click();
    assert(testPostedMessages.at(-1).level === 'high', 'Thinking did not cycle within supported levels');
    document.getElementById('btn-thinking').click();
    assert(testPostedMessages.at(-1).level === 'off', 'Thinking did not wrap around the supported list');
    send({ type: 'init', state: 'idle', model: 'other/model', modelReasoning: true, thinkingLevel: 'minimal' });
    document.getElementById('btn-thinking').click();
    assert(testPostedMessages.at(-1).level === 'low', 'Thinking did not fall back to the default list when levels are absent');
  });

  test('follow-up button is streaming-only and queues the draft after the current run', () => {
    const followupBtn = document.getElementById('btn-followup');
    type('then summarize');
    assert(followupBtn.classList.contains('hidden'), 'Follow-up button visible while idle');
    send({ type: 'init', state: 'streaming', model: 'provider/model' });
    assert(!followupBtn.classList.contains('hidden'), 'Follow-up button hidden while streaming with a draft');
    followupBtn.click();
    const prompt = testPostedMessages.at(-1);
    assert(prompt.type === 'prompt' && prompt.behavior === 'followUp' && prompt.streaming === true, 'Follow-up draft not queued');
    send({ type: 'sessionCleared' });
    send({ type: 'init', state: 'streaming', model: 'provider/model' });
    assert(followupBtn.classList.contains('hidden'), 'Follow-up button visible without a draft');
    // Enter still steers by default while streaming.
    type('change direction');
    key('Enter');
    const steer = testPostedMessages.at(-1);
    assert(steer.type === 'prompt' && steer.streaming === true && steer.behavior === undefined, 'Enter stopped steering by default');
  });

  test('queue bar clear button routes to the host and hides with an empty queue', () => {
    send({ type: 'queueUpdate', steering: ['First'], followUp: ['Later'] });
    const clearBtn = document.querySelector('.queue-clear');
    assert(clearBtn, 'Queue clear button missing');
    clearBtn.click();
    assert(testPostedMessages.at(-1).type === 'clearQueue', 'Clear queue not routed');
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    assert(document.getElementById('queue-bar').classList.contains('hidden'), 'Queue bar did not hide when emptied');
  });

  test('queued bubbles confirm, settle by count, survive transformed text, and clear', () => {
    send({ type: 'userMessage', text: 'steer it', queued: true, submissionId: 'q1' });
    send({ type: 'userMessage', text: 'later', queued: true, submissionId: 'q2', queueBehavior: 'followUp' });
    const queued = () => document.querySelectorAll('.message.user.queued');
    assert(queued().length === 2, 'Queued bubbles missing');
    // A queue_update that predates acknowledgment must not settle the new bubbles
    // (the steer-ahead-of-consumption race).
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    assert(queued().length === 2, 'Unacknowledged bubbles settled early');
    // Acknowledge both as queued; the queue still holds both.
    send({ type: 'promptResult', submissionId: 'q1', success: true, queued: true });
    send({ type: 'promptResult', submissionId: 'q2', success: true, queued: true });
    send({ type: 'queueUpdate', steering: ['steer it'], followUp: ['later'] });
    assert(queued().length === 2, 'Still-pending bubbles settled early');
    // One consumed: count-based reconciliation settles the older bubble only.
    send({ type: 'queueUpdate', steering: [], followUp: ['later'] });
    const settled = document.querySelector('[data-submission-id="q1"]');
    assert(settled && !settled.classList.contains('queued') && !settled.querySelector('.queued-tag'), 'Consumed steer bubble not settled');
    assert(queued().length === 1, 'Pending follow-up bubble settled wrongly');
    // Transformed queue text (expanded skill/template) must not break reconciliation.
    send({ type: 'userMessage', text: '/review', queued: true, submissionId: 'q3' });
    send({ type: 'promptResult', submissionId: 'q3', success: true, queued: true });
    send({ type: 'queueUpdate', steering: ['EXPANDED SKILL CONTENT'], followUp: ['later'] });
    assert(queued().length === 2, 'Transformed queue text broke count-based settling');
    // clear_queue removes every confirmed queued bubble, whatever text pi stored.
    send({ type: 'queueCleared', steering: ['EXPANDED SKILL CONTENT'], followUp: ['later'] });
    assert(!document.querySelector('.message.user.queued'), 'Cleared bubbles survived');
    assert(document.getElementById('queue-bar').classList.contains('hidden'), 'Queue bar did not hide after clear');
  });

  test('clear response removes only returned entries before buffered consumption is reconciled', () => {
    for (const id of ['consumed', 'cleared']) {
      send({ type: 'userMessage', text: id, queued: true, submissionId: id, queueBehavior: 'followUp' });
      send({ type: 'promptResult', submissionId: id, success: true, queued: true });
    }
    // Host buffers pi's empty queue_update until after this response. Only the
    // newest entry was cleared; the older one was consumed just before clearing.
    send({ type: 'queueCleared', steering: [], followUp: ['expanded cleared text'] });
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    assert(!document.querySelector('[data-submission-id="cleared"]'), 'Cleared entry survived');
    const consumed = document.querySelector('[data-submission-id="consumed"]');
    assert(consumed && !consumed.classList.contains('queued'), 'Consumed entry was removed instead of settled');
  });

  test('an early follow-up stays below current tools and text, above its own reply', () => {
    send({ type: 'userMessage', text: 'current task' });
    send({ type: 'agentStart' });
    send({ type: 'userMessage', text: 'fjdsk', queued: true, submissionId: 'early-follow', queueBehavior: 'followUp' });
    send({ type: 'promptResult', submissionId: 'early-follow', success: true, queued: true });
    send({ type: 'queueUpdate', steering: [], followUp: ['fjdsk'] });
    send({ type: 'toolStart', messageId: 'current', toolCallId: 'before-follow', toolName: 'read', args: '{}' });
    send({ type: 'toolEnd', toolCallId: 'before-follow', isError: false, output: 'ok' });
    send({ type: 'turnStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'Current task finished.' });
    const follow = document.querySelector('[data-submission-id="early-follow"]');
    const current = document.querySelector('.message.assistant');
    assert(current.nextElementSibling === follow, 'Early follow-up appeared above the current assistant reply');
    assert(current.querySelector('#tool-before-follow'), 'Current tool was misplaced');
    assert(follow.classList.contains('queued'), 'Follow-up settled before consumption');
    send({ type: 'turnStart' });
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    send({ type: 'assistantMessageStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'Follow-up answer.' });
    send({ type: 'agentEnd' });
    assert(current.textContent.includes('Current task finished.'), 'Current reply lost');
    assert(follow.previousElementSibling === current, 'Consumed follow-up moved above current reply');
    assert(follow.nextElementSibling?.textContent.includes('Follow-up answer.'), 'Follow-up answer is not below its prompt');
    assert(!current.textContent.includes('Follow-up answer.'), 'Follow-up answer merged into the current reply');
  });

  test('a later steer overtakes a follow-up without settling it or misordering replies', () => {
    send({ type: 'agentStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'Working.' });
    send({ type: 'userMessage', text: 'later task', queued: true, submissionId: 'later-task', queueBehavior: 'followUp' });
    send({ type: 'promptResult', submissionId: 'later-task', success: true, queued: true });
    send({ type: 'userMessage', text: 'change direction', queued: true, submissionId: 'priority-steer', queueBehavior: 'steer' });
    send({ type: 'promptResult', submissionId: 'priority-steer', success: true, queued: true });
    send({ type: 'queueUpdate', steering: ['expanded steer'], followUp: ['expanded follow-up'] });
    send({ type: 'turnStart' });
    send({ type: 'queueUpdate', steering: [], followUp: ['expanded follow-up'] });
    const follow = document.querySelector('[data-submission-id="later-task"]');
    const steer = document.querySelector('[data-submission-id="priority-steer"]');
    assert(follow.classList.contains('queued'), 'Steer consumption incorrectly settled the older follow-up');
    assert(!steer.classList.contains('queued'), 'Consumed steer stayed pending');
    assert(steer.nextElementSibling === follow, 'Delivered steer did not overtake the follow-up');
    send({ type: 'assistantMessageStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'Changed direction.' });
    send({ type: 'agentEnd' });
    assert(steer.nextElementSibling?.textContent.includes('Changed direction.'), 'Steered answer is misplaced');
    assert(follow.previousElementSibling === steer.nextElementSibling, 'Follow-up did not remain below the active reply');
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    send({ type: 'agentStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'Later task answer.' });
    send({ type: 'agentEnd' });
    assert(follow.nextElementSibling?.textContent.includes('Later task answer.'), 'Next-run follow-up reply is misplaced');
  });

  test('follow-ups remain FIFO when consumed one at a time', () => {
    send({ type: 'agentStart' });
    for (const id of ['follow-1', 'follow-2']) {
      send({ type: 'userMessage', text: id, queued: true, submissionId: id, queueBehavior: 'followUp' });
      send({ type: 'promptResult', submissionId: id, success: true, queued: true });
    }
    send({ type: 'textDelta', messageId: 'current', delta: 'Original reply.' });
    send({ type: 'turnStart' });
    send({ type: 'queueUpdate', steering: [], followUp: ['follow-2'] });
    send({ type: 'assistantMessageStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'First follow-up reply.' });
    send({ type: 'agentEnd' });
    const first = document.querySelector('[data-submission-id="follow-1"]');
    const second = document.querySelector('[data-submission-id="follow-2"]');
    assert(!first.classList.contains('queued') && second.classList.contains('queued'), 'Wrong follow-up consumed');
    assert(first.previousElementSibling?.textContent.includes('Original reply.'), 'Original reply is misplaced');
    assert(first.nextElementSibling?.textContent.includes('First follow-up reply.'), 'First follow-up reply is misplaced');
    assert(second.previousElementSibling === first.nextElementSibling, 'Second follow-up is ahead of the first reply');
  });

  test('a handled prompt drops its optimistic bubble and keeps the draft editable', () => {
    type('steer this');
    button.click();
    const prompt = testPostedMessages.at(-1);
    assert(prompt.type === 'prompt', 'Prompt not sent');
    send({ type: 'userMessage', text: 'steer this', queued: true, submissionId: prompt.submissionId });
    send({ type: 'promptHandled', submissionId: prompt.submissionId });
    assert(!document.querySelector('.message.user.queued'), 'Handled bubble survived');
    assert(input.value === 'steer this', 'Draft lost after handled prompt');
    assert(!button.disabled, 'Composer stayed locked after handled prompt');
  });

  test('a steer between turns starts a new assistant bubble below the delivered message', () => {
    send({ type: 'agentStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'First turn answer.' });
    send({ type: 'userMessage', text: 'say BANANA instead', queued: true, submissionId: 's1' });
    // Still queued: a tool-loop turn must NOT split below it (message not delivered yet).
    send({ type: 'turnStart' });
    send({ type: 'assistantMessageStart' });
    send({ type: 'textDelta', messageId: 'current', delta: ' (tool loop continues)' });
    send({ type: 'agentEnd' }); // flush renders
    assert(document.querySelectorAll('.message.assistant').length === 1, 'Queued (undelivered) bubble split the assistant message');
    // Real pi order: turn_start precedes queued user delivery (queue_update),
    // then message_start(assistant). Checking only turn_start misses the split.
    send({ type: 'promptResult', submissionId: 's1', success: true, queued: true });
    send({ type: 'turnStart' });
    send({ type: 'queueUpdate', steering: [], followUp: [] });
    send({ type: 'assistantMessageStart' });
    send({ type: 'textDelta', messageId: 'current', delta: 'BANANA' });
    send({ type: 'agentEnd' });
    const bubbles = document.querySelectorAll('.message.assistant');
    assert(bubbles.length === 2, 'Steered reply continued in the old bubble');
    assert(bubbles[1].textContent.includes('BANANA'), 'New bubble missing the steered reply');
    assert(!bubbles[0].textContent.includes('BANANA'), 'Old bubble contaminated by the steered reply');
    const order = Array.from(document.querySelectorAll('.message')).map(el => el.className);
    assert(order[0].includes('assistant') && order[1].includes('user') && order[2].includes('assistant'),
      `Conversation order wrong: ${order.join(' | ')}`);
  });

  for (const firstBlock of ['thinking', 'tool']) {
    test(`a consumed steer starts a fresh bubble even when the reply begins with ${firstBlock}`, () => {
      send({ type: 'agentStart' });
      send({ type: 'textDelta', messageId: 'current', delta: 'Original answer.' });
      send({ type: 'userMessage', text: '好久了', queued: true, submissionId: 'boundary-steer', queueBehavior: 'steer' });
      send({ type: 'promptResult', submissionId: 'boundary-steer', success: true, queued: true });
      send({ type: 'turnStart' });
      send({ type: 'queueUpdate', steering: [], followUp: [] });
      send({ type: 'assistantMessageStart' });
      if (firstBlock === 'thinking') {
        send({ type: 'thinkingDelta', messageId: 'current', blockIndex: 0, delta: 'New reasoning' });
        send({ type: 'thinkingEnd', messageId: 'current', blockIndex: 0, content: 'New reasoning' });
      } else {
        send({ type: 'toolStart', messageId: 'current', toolCallId: 'steered-tool', toolName: 'read', args: '{}' });
        send({ type: 'toolEnd', toolCallId: 'steered-tool', isError: false, output: 'ok' });
      }
      send({ type: 'textDelta', messageId: 'current', delta: 'New answer.' });
      send({ type: 'agentEnd' });
      const bubbles = document.querySelectorAll('.message.assistant');
      const user = document.querySelector('[data-submission-id="boundary-steer"]');
      assert(bubbles.length === 2, 'Reply reused the old assistant bubble');
      assert(user.previousElementSibling === bubbles[0] && user.nextElementSibling === bubbles[1], 'Steer is not between the replies');
      assert(bubbles[0].textContent.includes('Original answer.') && !bubbles[0].textContent.includes('New'), 'Original answer changed');
      assert(bubbles[1].textContent.includes('New answer.'), 'New answer missing');
      assert(bubbles[1].querySelector(firstBlock === 'thinking' ? '.thinking-block' : '#tool-steered-tool'), 'First reply block is misplaced');
    });
  }

  test('host draft edits sent during acknowledgment are buffered, not dropped', () => {
    type('steer this');
    button.click(); // submission pending: composer locked awaiting promptResult
    const submissionId = testPostedMessages.find(m => m.type === 'prompt').submissionId;
    send({ type: 'setInputText', text: 'restored queue draft', append: true });
    assert(input.value === 'steer this', 'Buffered text leaked into the locked draft');
    send({ type: 'promptResult', submissionId, success: true, queued: true });
    // Draft was cleared on success, then the buffered restore is applied.
    assert(input.value === 'restored queue draft', `Buffered restore lost: ${JSON.stringify(input.value)}`);
  });

  test('a prompt that started a run (stale streaming flag) settles its bubble at once', () => {
    send({ type: 'userMessage', text: 'queued-looking follow-up', queued: true, submissionId: 'f1' });
    assert(document.querySelector('.message.user.queued'), 'Queued bubble missing');
    send({ type: 'promptResult', submissionId: 'f1', success: true, queued: false });
    const el = document.querySelector('[data-submission-id="f1"]');
    assert(el && !el.classList.contains('queued') && !el.querySelector('.queued-tag'), 'Started prompt left its bubble queued');
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
