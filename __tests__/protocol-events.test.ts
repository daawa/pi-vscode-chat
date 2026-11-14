import { afterEach, describe, expect, test } from 'bun:test';
import { createProvider, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

// Covers alignment with the current pi RPC protocol (../pi-mono docs/json.md).

describe('run lifecycle events', () => {
  test('agent_end with willRetry stays streaming; agent_settled is the definitive idle marker', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('event', { type: 'agent_start' });
    expect(messages.some(m => m.type === 'agentStart')).toBe(true);
    messages.length = 0;

    // An automatic retry follows, so this agent_end must not settle the UI.
    pi.emit('event', { type: 'agent_end', messages: [], willRetry: true });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(false);

    // A run end without a retry is reported as before.
    pi.emit('event', { type: 'agent_end', messages: [], willRetry: false });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(true);
    messages.length = 0;

    // agent_settled always settles, including after queued steering/follow-up work.
    pi.emit('event', { type: 'agent_settled', aborted: false });
    expect(messages.some(m => m.type === 'agentEnd')).toBe(true);
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

  test('state-changing events trigger a UI refresh', async () => {
    const { pi, provider } = await createProvider();
    const states: unknown[] = [];
    provider.session.sendState = async () => { states.push('state'); };
    pi.emit('event', { type: 'thinking_level_changed', level: 'high' });
    pi.emit('event', { type: 'session_info_changed', name: 'renamed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toHaveLength(2);
  });
});

describe('queue and abort semantics', () => {
  test('interactive abort clears the queue first and restores drafts to the composer', async () => {
    const { pi, provider, messages } = await createProvider();
    pi.clearQueue.mockResolvedValueOnce({ steering: ['change direction'], followUp: ['then summarize'] });
    await provider.handleMessage({ type: 'abort' });
    expect(pi.clearQueue).toHaveBeenCalledTimes(1);
    expect(pi.abort).toHaveBeenCalledTimes(1);
    const draft = messages.find(m => m.type === 'setInputText');
    expect(draft).toMatchObject({ text: 'change direction\n\nthen summarize', append: true });
  });

  test('abort with an empty queue does not touch the composer draft', async () => {
    const { pi, provider, messages } = await createProvider();
    await provider.handleMessage({ type: 'abort' });
    expect(pi.abort).toHaveBeenCalledTimes(1);
    expect(messages.some(m => m.type === 'setInputText')).toBe(false);
  });

  test('clearQueue message forwards to pi', async () => {
    const { pi, provider } = await createProvider();
    await provider.handleMessage({ type: 'clearQueue' });
    expect(pi.clearQueue).toHaveBeenCalledTimes(1);
  });

  test('prompt with followUp behavior is forwarded through submit', async () => {
    const { pi, provider } = await createProvider();
    await provider.handleMessage({ type: 'prompt', text: 'then summarize', streaming: true, behavior: 'followUp' });
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
});
