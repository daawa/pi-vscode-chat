import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createProvider, readFile, showOpenDialog, stat, parseUri, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);
import { PNG } from './image-fixtures.ts';

describe('image input bridge', () => {
  const images = [{ data: PNG, mime: 'image/png', name: 'screenshot.png' }];

  test.each([false, true])('image-only prompt and authoritative streaming=%s', async (streaming) => {
    const { provider, pi, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['text', 'image'] }, isStreaming: streaming });
    await provider.handleMessage({ type: 'prompt', submissionId: 'send-1', text: '', images, streaming: !streaming });
    expect(pi.prompt).toHaveBeenCalledWith('', images, streaming ? 'steer' : undefined);
    expect(messages.find(m => m.type === 'userMessage')).toMatchObject({ text: '', images, queued: streaming, submissionId: 'send-1' });
    expect(messages.find(m => m.type === 'promptResult')).toEqual({ type: 'promptResult', submissionId: 'send-1', success: true });
  });

  test('exposes image capability in live model state', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['text', 'image'] } });
    await provider.session.sendState();
    expect(messages[0].modelSupportsImages).toBe(true);
    pi.getState.mockResolvedValue({ model: { input: ['text'] } });
    await provider.session.sendState();
    expect(messages[1].modelSupportsImages).toBe(false);
  });

  test.each([
    { images, model: { input: ['text'] }, error: 'supports images' },
    { images: [{ data: PNG, mime: 'image/jpeg' }], model: { input: ['image'] }, error: 'MIME' },
    { images: [{ data: 'data:image/png;base64,' + PNG, mime: 'image/png' }], model: { input: ['image'] }, error: 'base64' },
  ])('invalid/unsupported input is rejected before echoing: %j', async ({ images, model, error }) => {
    const { provider, pi, edits, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model });
    await provider.handleMessage({ type: 'prompt', submissionId: 'bad', text: '', images });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(edits.snapshotWorkspace).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'userMessage')).toBe(false);
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ success: false, error: expect.stringContaining(error) });
  });

  test('RPC rejection acknowledges failure, then allows retry', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.prompt.mockResolvedValueOnce({ success: false, error: 'Authentication required' } as any);
    await provider.handleMessage({ type: 'prompt', submissionId: 'bad', text: 'Describe this' });
    expect(messages.find(m => m.type === 'promptResult')).toMatchObject({ success: false, error: expect.stringContaining('Authentication required') });
    expect(provider.session.submitting).toBe(false);
    await provider.handleMessage({ type: 'prompt', submissionId: 'retry', text: 'Describe this' });
    expect(messages.filter(m => m.type === 'promptResult').at(-1)).toMatchObject({ submissionId: 'retry', success: true });
  });

  test('loading and in-flight submissions reject IPC with a correlated acknowledgment', async () => {
    const { provider, pi, messages } = await createProvider(false);
    await provider.handleMessage({ type: 'prompt', submissionId: 'loading', text: 'Draft' });
    expect(messages[0]).toMatchObject({ type: 'promptResult', submissionId: 'loading', success: false });
    await provider.session.loadHistory();
    let release!: (value: any) => void;
    pi.prompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = provider.handleMessage({ type: 'prompt', submissionId: 'one', text: 'First' });
    await Promise.resolve();
    await provider.handleMessage({ type: 'prompt', submissionId: 'two', text: 'Duplicate' });
    await provider.newSession();
    expect(pi.newSession).not.toHaveBeenCalled();
    expect(pi.prompt).toHaveBeenCalledTimes(1);
    expect(messages.find(m => m.submissionId === 'two')).toMatchObject({ success: false });
    release({ success: true });
    await pending;
  });

  test('rejects image-consuming extension commands but allows prompt templates', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.getState.mockResolvedValue({ model: { input: ['image'] } });
    pi.getCommands = async () => [{ name: 'name', source: 'extension' }, { name: 'review', source: 'prompt' }] as any;
    await provider.handleMessage({ type: 'prompt', submissionId: 'cmd', text: '/name x', images });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(messages.find(m => m.type === 'promptResult').error).toContain('Extension commands');
    await provider.handleMessage({ type: 'prompt', submissionId: 'template', text: '/review', images });
    expect(pi.prompt).toHaveBeenCalledWith('/review', images, undefined);
  });

  test('picker reads image bytes via workspace.fs and preserves ordinary file references', async () => {
    const { provider, messages } = await createProvider();
    showOpenDialog.mockResolvedValue([parseUri('file:///workspace/a%20b.png'), parseUri('file:///workspace/code.ts')]);
    readFile.mockResolvedValue(Buffer.from(PNG, 'base64'));
    await provider.handleMessage({ type: 'selectFileToAttach', requestId: 'pick' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ type: 'attachmentsSelected', requestId: 'pick', errors: [], attachments: [
      { id: 'file:///workspace/a%20b.png', type: 'image', name: 'a b.png', data: PNG, mime: 'image/png' },
      { type: 'file', name: 'code.ts', path: '/workspace/code.ts' },
    ] });
  });

  test('remote URI authority survives attachment ingestion; duplicates are read once', async () => {
    const { provider, messages } = await createProvider();
    const uri = 'vscode-remote://ssh-remote+host/workspace/screenshot.png';
    readFile.mockResolvedValue(Buffer.from(PNG, 'base64'));
    await provider.handleMessage({ type: 'attachFiles', requestId: 'drop', uris: [uri, uri] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((readFile.mock.calls[0][0] as any).toString()).toBe(uri);
    expect(messages[0].attachments[0]).toMatchObject({ id: uri, type: 'image', data: PNG });
  });

  test('cancelled picker always completes the read lifecycle', async () => {
    const { provider, messages } = await createProvider();
    await provider.handleMessage({ type: 'selectFileToAttach', requestId: 'cancel' });
    expect(messages[0]).toEqual({ type: 'attachmentsSelected', requestId: 'cancel', attachments: [], errors: [] });
  });

  test('oversized, unreadable, and unsupported images report errors without payloads', async () => {
    const { provider, messages } = await createProvider();
    stat.mockResolvedValueOnce({ type: 1, size: 5 * 1024 * 1024 });
    readFile.mockRejectedValueOnce(new Error('Permission denied'));
    readFile.mockResolvedValueOnce(Buffer.from('<svg width="1" height="1"></svg>'));
    await provider.handleMessage({ type: 'attachFiles', requestId: 'bad-files', uris: [
      'file:///large.png', 'file:///private.png', 'file:///vector.svg', 'https://example.com/image.png',
    ] });
    expect(messages[0].attachments).toEqual([]);
    expect(messages[0].errors).toHaveLength(4);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  test('RPC serializes images for prompts and steering without UI metadata or data URL prefixes', async () => {
    const { PiRpcClient } = await import('../src/pi-rpc-client.ts');
    const client = new PiRpcClient({ command: 'pi' });
    client.send = mock(async () => ({ type: 'response', command: 'prompt', success: true }));
    await client.prompt('', images, 'steer');
    expect(client.send).toHaveBeenCalledWith({ type: 'prompt', message: '', streamingBehavior: 'steer',
      images: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
    await client.steer('Look here', images);
    expect(client.send).toHaveBeenLastCalledWith({ type: 'steer', message: 'Look here',
      images: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
  });
});
