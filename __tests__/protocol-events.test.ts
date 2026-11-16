import { afterEach, describe, expect, test } from 'bun:test';
import { createProvider, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

// Covers alignment with the current pi RPC protocol (../pi-mono docs/json.md).

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('run lifecycle events', () => {
  test('agent_settled settles once; agent_end alone never settles twice', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'agent_start' });
    expect(messages.some(m => m.type === 'agentStart')).toBe(true);
    messages.length = 0;

    // An automatic retry follows: no settle.
    pi.emit('event', { type: 'agent_end', messages: [], willRetry: true });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false);

    // A run end without a retry does not settle either: pi emits agent_settled
    // right after, and queued steering/follow-up may still start another run.
    pi.emit('event', { type: 'agent_end', messages: [], willRetry: false });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false);

    pi.emit('event', { type: 'agent_settled', aborted: false });
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
    messages.length = 0;

    // After pi has proven it emits agent_settled, later agent_ends are ignored.
    pi.emit('event', { type: 'agent_start' });
    pi.emit('event', { type: 'agent_end', messages: [], willRetry: false });
    pi.emit('event', { type: 'agent_settled', aborted: false });
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
  });

  test('older pi without agent_settled settles via the grace fallback', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'agent_start' });
    pi.emit('event', { type: 'agent_end', messages: [] });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false); // grace pending
    await sleep(320);
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
  });

  test('a run started during the grace window cancels the fallback settle', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'agent_start' });
    pi.emit('event', { type: 'agent_end', messages: [] }); // queued follow-up starts next
    pi.emit('event', { type: 'agent_start' });
    await sleep(320);
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false); // still streaming
    pi.emit('event', { type: 'agent_settled', aborted: false });
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
  });

  test('compaction between runs cancels the fallback settle (work continues)', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'agent_start' });
    pi.emit('event', { type: 'agent_end', messages: [] }); // overflow → compaction → retry
    pi.emit('event', { type: 'compaction_start', reason: 'overflow' });
    await sleep(320);
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false); // compaction keeps the run alive
    pi.emit('event', { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
    pi.emit('event', { type: 'agent_start' });
    pi.emit('event', { type: 'agent_settled', aborted: false });
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
  });

  test('reset re-probes agent_settled support and returns the UI to idle', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.emit('event', { type: 'agent_settled', aborted: false }); // settledSeen = true
    await provider.session.setStreaming(true);
    messages.length = 0;
    provider.events.reset(); // session change / respawn
    await sleep(20); // let reset's async state refresh land
    // The controller returned to idle.
    expect(messages.filter(m => m.type === 'init').at(-1)?.state).toBe('idle');
    // settledSeen was reset: the next agent_end uses the short (250ms) grace again,
    // not the long one, so an unproven build still settles promptly.
    pi.emit('event', { type: 'agent_start' });
    messages.length = 0;
    pi.emit('event', { type: 'agent_end', messages: [] });
    await sleep(320);
    expect(messages.filter(m => m.type === 'agentEnd')).toHaveLength(1);
  });

  test('thinking_end authoritative content uses the current wire field', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: 'final thought' } });
    expect(messages.find(m => m.type === 'thinkingEnd')).toMatchObject({ blockIndex: 1, content: 'final thought' });
  });

  test('thinking_end still tolerates the deprecated thinking field from older pi', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, thinking: 'legacy thought' } });
    expect(messages.find(m => m.type === 'thinkingEnd')).toMatchObject({ blockIndex: 0, content: 'legacy thought' });
  });

  test('bursty metadata events coalesce into a single refresh', async () => {
    const { pi, provider } = await createProvider();
    const states: unknown[] = [];
    provider.session.sendState = async () => { states.push('state'); };
    pi.emit('event', { type: 'thinking_level_changed', level: 'high' });
    pi.emit('event', { type: 'session_info_changed', name: 'renamed' });
    pi.emit('event', { type: 'entry_appended', entry: { type: 'note' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toHaveLength(0); // debounced, not one round trip per event
    await sleep(150);
    expect(states).toHaveLength(1);
  });
});

describe('queue and abort semantics', () => {
  test('interactive abort clears the queue first and restores drafts to the composer', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.clearQueue.mockResolvedValueOnce({ steering: ['change direction'], followUp: ['then summarize'] });
    await provider.handleMessage({ type: 'abort' });
    expect(pi.clearQueue).toHaveBeenCalledTimes(1);
    expect(pi.abort).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    const cleared = messages.find(m => m.type === 'queueCleared');
    expect(cleared).toMatchObject({ steering: ['change direction'], followUp: ['then summarize'] });
    expect(messages.find(m => m.type === 'setInputText')).toMatchObject({ text: 'change direction\n\nthen summarize', append: true });
  });

  test('abort is not blocked by a slow clear_queue response', async () => {
    const { pi, provider } = await createProvider();
    pi.clearQueue.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    await provider.handleMessage({ type: 'abort' });
    expect(pi.abort).toHaveBeenCalledTimes(1); // abort already sent
  });

  test('abort with an empty queue does not touch the composer draft', async () => {
    const { pi, provider, messages } = await createProvider();
    await provider.handleMessage({ type: 'abort' });
    expect(pi.abort).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.some(m => m.type === 'setInputText')).toBe(false);
  });

  test('queue bar clear restores drafts instead of dropping them', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.clearQueue.mockResolvedValueOnce({ steering: [], followUp: ['later'] });
    await provider.handleMessage({ type: 'clearQueue' });
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.find(m => m.type === 'queueCleared')).toMatchObject({ steering: [], followUp: ['later'] });
    expect(messages.find(m => m.type === 'setInputText')).toMatchObject({ text: 'later', append: true });
  });

  test('clear_queue removes bubbles before forwarding its empty queue_update', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.clearQueue.mockImplementationOnce(async () => {
      pi.emit('event', { type: 'queue_update', steering: [], followUp: [] });
      return { steering: [], followUp: ['later'] };
    });
    await provider.handleMessage({ type: 'clearQueue' });
    await sleep(0);
    const queueEvents = messages.filter(m => m.type === 'queueCleared' || m.type === 'queueUpdate');
    expect(queueEvents.map(m => m.type)).toEqual(['queueCleared', 'queueUpdate']);
    expect(queueEvents[0].followUp).toEqual(['later']);
  });

  test('a failed clear request releases buffered queue updates', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.clearQueue.mockImplementationOnce(async () => {
      pi.emit('event', { type: 'queue_update', steering: ['pending'], followUp: [] });
      throw new Error('unsupported');
    });
    await provider.handleMessage({ type: 'clearQueue' });
    await sleep(0);
    expect(messages.some(m => m.type === 'queueCleared')).toBe(false);
    expect(messages.find(m => m.type === 'queueUpdate')).toMatchObject({ steering: ['pending'] });
  });

  test('a delayed clear response cannot restore drafts into a different session', async () => {
    const { pi, provider, messages } = await createProvider();
    let resolve!: (queue: { steering: string[]; followUp: string[] }) => void;
    pi.clearQueue.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await provider.handleMessage({ type: 'clearQueue' });
    await provider.newSession();
    resolve({ steering: ['old session draft'], followUp: [] });
    await sleep(0);
    expect(messages.some(m => m.type === 'queueCleared' || m.type === 'setInputText')).toBe(false);
  });

  test('a stale idle webview still marks a host-streaming steer as queued', async () => {
    const { pi, provider, messages } = await createProvider();
    await provider.session.setStreaming(true);
    pi.prompt.mockResolvedValueOnce({ success: true, data: { disposition: 'queued' } });
    await provider.handleMessage({ type: 'prompt', text: 'change direction', streaming: false, submissionId: 'stale-steer' });
    expect(messages.find(m => m.type === 'userMessage')).toMatchObject({ queued: true, queueBehavior: 'steer' });
    expect(pi.prompt).toHaveBeenCalledWith('change direction', undefined, 'steer');
  });

  test('a steer consumed by an input handler drops its queued bubble and keeps the draft', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.prompt.mockResolvedValueOnce({ success: true, data: { disposition: 'handled' } });
    await provider.handleMessage({ type: 'prompt', text: 'steer this', streaming: true, submissionId: 'sub-1' });
    expect(messages.some(m => m.type === 'promptHandled' && m.submissionId === 'sub-1')).toBe(true);
    expect(messages.some(m => m.type === 'promptResult')).toBe(false);
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false); // nothing to settle
  });

  test('a queued steer is acknowledged with queued:true for bubble reconciliation', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.prompt.mockResolvedValueOnce({ success: true, data: { disposition: 'queued' } });
    await provider.handleMessage({ type: 'prompt', text: 'steer this', streaming: true, submissionId: 'sub-2' });
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ submissionId: 'sub-2', success: true, queued: true });
  });

  test('an idle prompt consumed by a handler settles via init, without a manual agentEnd', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.prompt.mockResolvedValueOnce({ success: true, data: { disposition: 'handled' } });
    pi.getSessionStats.mockResolvedValueOnce({ userMessages: 1, assistantMessages: 0, toolCalls: 0, totalMessages: 1 });
    await provider.handleMessage({ type: 'prompt', text: '/custom', submissionId: 'sub-3' });
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ success: true, queued: false });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false); // no synthetic settle
    expect(messages.some(m => m.type === 'stats')).toBe(true); // stats refreshed
  });

  test('followUp behavior survives a stale webview streaming flag', async () => {
    const { pi, provider } = await createProvider();
    await provider.session.setStreaming(true); // host truth: a run is active
    await provider.handleMessage({ type: 'prompt', text: 'then summarize', streaming: false, behavior: 'followUp' });
    expect(pi.prompt).toHaveBeenCalledWith('then summarize', undefined, 'followUp');
  });
});

describe('thinking levels from the server', () => {
  test('init carries model-scoped thinking levels and refetches only on model change', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model: { provider: 'anthropic', id: 'claude-opus-4', input: ['text'], reasoning: true }, isStreaming: false, thinkingLevel: 'medium', sessionId: 's1' });
    pi.getAvailableThinkingLevels.mockResolvedValueOnce(['off', 'low', 'medium', 'high']);
    await provider.session.sendState();
    expect(pi.getAvailableThinkingLevels).toHaveBeenCalledTimes(1);
    expect(messages.find(m => m.type === 'init')).toMatchObject({ thinkingLevels: ['off', 'low', 'medium', 'high'] });

    // Same model: cached, no extra round-trip.
    await provider.session.sendState();
    expect(pi.getAvailableThinkingLevels).toHaveBeenCalledTimes(1);

    // Model change: refetched.
    pi.getAvailableThinkingLevels.mockResolvedValueOnce(['off']);
    pi.getState.mockResolvedValue({ model: { provider: 'openai', id: 'gpt-5', input: ['text'] }, isStreaming: false, thinkingLevel: 'off', sessionId: 's1' });
    await provider.session.sendState();
    expect(pi.getAvailableThinkingLevels).toHaveBeenCalledTimes(2);
  });

  test('a failed levels fetch is retried on the next refresh', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model: { provider: 'anthropic', id: 'claude-opus-4', input: ['text'], reasoning: true }, isStreaming: false, thinkingLevel: 'medium', sessionId: 's1' });
    pi.getAvailableThinkingLevels.mockRejectedValueOnce(new Error('busy'));
    await provider.session.sendState();
    expect(pi.getAvailableThinkingLevels).toHaveBeenCalledTimes(1);
    expect(messages.find(m => m.type === 'init')?.thinkingLevels).toBeUndefined(); // webview falls back

    pi.getAvailableThinkingLevels.mockResolvedValueOnce(['off', 'high']);
    await provider.session.sendState();
    expect(pi.getAvailableThinkingLevels).toHaveBeenCalledTimes(2); // retried, not lost
    expect(messages.filter(m => m.type === 'init').at(-1)).toMatchObject({ thinkingLevels: ['off', 'high'] });
  });
});
