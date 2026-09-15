import { afterEach, describe, expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  createProvider, createView, EditManager, resetHostFixture, contentProviders, documentClosed,
  executeCommand, commandHandlers, showQuickPick,
} from './host-fixture.ts';
import { registerCommands } from '../src/commands.ts';
import { ModelService } from '../src/services/model-service.ts';
import type { PiRpcClient } from '../src/pi-rpc-client.ts';
import { getAgentDirectory, getSessionDirectory } from '../src/configuration.ts';
afterEach(resetHostFixture);

const visionModel = { id: 'vision', provider: 'allowed', name: 'Vision', input: ['text', 'image'], reasoning: true };

describe('shared model selection', () => {
  test('sidebar and command palette use the same picker and both refresh vision capability', async () => {
    const { provider, pi, edits, messages } = await createProvider();
    pi.getModels.mockResolvedValue([visionModel]);
    pi.getState.mockResolvedValue({ model: visionModel, isStreaming: false });
    showQuickPick.mockImplementation(async items => items[0]);
    const commands = registerCommands({} as vscode.ExtensionContext, pi as unknown as PiRpcClient,
      edits as InstanceType<typeof EditManager>, provider);
    try {
      await provider.handleMessage({ type: 'selectModel' });
      await commandHandlers.get('piChat.selectModel')!();
      expect(showQuickPick.mock.calls[0]).toEqual(showQuickPick.mock.calls[1]);
      expect(pi.setModel).toHaveBeenCalledTimes(2);
      expect(messages.filter(message => message.type === 'init')).toEqual([
        expect.objectContaining({ model: 'allowed/vision', modelSupportsImages: true }),
        expect.objectContaining({ model: 'allowed/vision', modelSupportsImages: true }),
      ]);
    } finally { commands.dispose(); }
    expect(commandHandlers.size).toBe(0);
  });

  test('auth filtering uses the configured agent directory; failed selection does not claim success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-auth-'));
    const { pi } = await createProvider();
    const changed = mock(async () => {});
    const service = new ModelService(pi as unknown as PiRpcClient, dir, changed);
    try {
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({ allowed: { type: 'api_key', key: 'fake-test-token' } }));
      pi.getModels.mockResolvedValue([visionModel, { ...visionModel, provider: 'unconfigured' }]);
      showQuickPick.mockImplementation(async items => items[0]);
      await service.selectModel();
      expect(showQuickPick.mock.calls[0][0]).toHaveLength(1);
      expect(pi.setModel).toHaveBeenCalledWith('allowed', 'vision');
      expect(changed).toHaveBeenCalledTimes(1);
      pi.setModel.mockResolvedValue(false);
      await expect(service.selectModel()).rejects.toThrow('Failed to change model');
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('cancelling a model picker does not send set_model or refresh state', async () => {
    const { provider, pi, messages } = await createProvider();
    pi.getModels.mockResolvedValue([visionModel]);
    await provider.selectModel();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });
});

describe('host resource ownership', () => {
  test('re-resolving a view removes old bindings; disposing removes process/edit/editor subscriptions', async () => {
    const { provider, pi, messages, view } = await createProvider();
    expect(contentProviders.size).toBe(1);
    expect(documentClosed.listenerCount('close')).toBe(1);
    const replacement = createView(messages);
    provider.resolveWebviewView(replacement as unknown as vscode.WebviewView);
    expect(view.inbound.listenerCount('event')).toBe(0);
    expect(view.visibility.listenerCount('event')).toBe(0);
    expect(view.closed.listenerCount('event')).toBe(0);
    expect(replacement.inbound.listenerCount('event')).toBe(1);
    replacement.closed.emit('event');
    expect(replacement.inbound.listenerCount('event')).toBe(0);
    expect(pi.listenerCount('event')).toBe(1); // Session tracking survives a closed view.
    provider.dispose(); provider.dispose();
    expect(pi.listenerCount('event')).toBe(0);
    expect(pi.listenerCount('exit')).toBe(0);
    expect(pi.listenerCount('transportError')).toBe(0);
    expect(contentProviders.size).toBe(0);
    expect(documentClosed.listenerCount('close')).toBe(0);
    pi.emit('event', { type: 'agent_start' });
    expect(messages).toEqual([]);
  });

  test('original-content cache follows diff document lifetime, not session lifetime', async () => {
    const manager = new EditManager();
    await manager.snapshotFile('/workspace/example.txt');
    const record = await manager.recordEdit('/workspace/example.txt', 'modified');
    const { provider } = await createProvider(true, manager);
    await provider.handleMessage({ type: 'showDiff', editId: record.id });
    const original = executeCommand.mock.calls[0][1] as vscode.Uri;
    const content = [...contentProviders][0] as vscode.TextDocumentContentProvider;
    expect(content.provideTextDocumentContent(original, {} as vscode.CancellationToken)).toBe(record.originalContent);
    await provider.newSession();
    expect(content.provideTextDocumentContent(original, {} as vscode.CancellationToken)).toBe(record.originalContent);
    documentClosed.emit('close', { uri: original });
    expect(content.provideTextDocumentContent(original, {} as vscode.CancellationToken)).toBe('');
  });

  test('failed diff opening releases cached content and produces an observed error', async () => {
    const manager = new EditManager();
    await manager.snapshotFile('/workspace/example.txt');
    const record = await manager.recordEdit('/workspace/example.txt', 'modified');
    const { provider, messages } = await createProvider(true, manager);
    executeCommand.mockRejectedValue(new Error('Editor unavailable'));
    await provider.handleMessage({ type: 'showDiff', editId: record.id });
    const original = executeCommand.mock.calls[0][1] as vscode.Uri;
    const content = [...contentProviders][0] as vscode.TextDocumentContentProvider;
    expect(content.provideTextDocumentContent(original, {} as vscode.CancellationToken)).toBe('');
    expect(messages.find(message => message.type === 'error').message).toContain('Editor unavailable');
  });

  test('asynchronous transport errors reach the webview without an unhandled special error event', async () => {
    const { pi, messages } = await createProvider();
    pi.emit('transportError', new Error('spawn ENOENT'));
    expect(messages).toEqual([{ type: 'error', message: 'Pi: spawn ENOENT' }]);
  });
});

describe('source/configuration contracts', () => {
  test('source filenames use kebab-case', () => {
    const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true }) as string[];
    expect(files.filter(file => file.endsWith('.ts')).every(file => /^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/.test(basename(file)))).toBe(true);
  });

  test('session listing and auth resolve the same configured agent directory', () => {
    const options = { command: 'pi', cwd: '/work/project', env: { PI_CODING_AGENT_DIR: './agent' } };
    expect(getAgentDirectory(options.env, options.cwd)).toBe('/work/project/agent');
    expect(getSessionDirectory(options)).toBe('/work/project/agent/sessions/--work-project--');
    expect(getSessionDirectory({ ...options, args: ['--session-dir', './history'] })).toBe('/work/project/history');
    const custom = { ...options, env: { ...options.env, PI_CODING_AGENT_SESSION_DIR: '/history' } };
    expect(getSessionDirectory(custom)).toBe('/history');
    expect(getSessionDirectory({ ...custom, args: ['--session-dir', '/override'] })).toBe('/override');
    expect(getSessionDirectory({ ...custom, args: ['--', '--session-dir', '/not-an-option'] })).toBe('/history');
    expect(getSessionDirectory({ command: 'pi' })).toBe('');
    expect(getAgentDirectory({ HOME: '/custom/home', USERPROFILE: '/custom/home' })).toBe('/custom/home/.pi/agent');
  });
});
