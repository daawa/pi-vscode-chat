import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDependencies, findExecutable, hasPackage, PI_SKILLS } from '../src/setup/dependencies.ts';

describe('dependency discovery', () => {
  test('one asynchronous global inventory serves the engine and every skill', async () => {
    const io = {
      findExecutable: mock(async (name: string) => `/bin/${name}`),
      exists: mock(async () => false),
      globalPackages: mock(async () => ['@earendil-works/pi-coding-agent', ...PI_SKILLS.map(skill => skill.name)]
        .map(name => `├── ${name}@1.0.0`).join('\n')),
    };
    const report = await collectDependencies({ command: 'pi', agentDirectory: '/agent', projectDirectory: '/project' }, io);
    expect(io.globalPackages).toHaveBeenCalledTimes(1);
    expect(report.slice(0, 4 + PI_SKILLS.length).every(item => item.ok)).toBe(true);
    expect(report.slice(-2).every(item => !item.ok && item.action === 'bun install')).toBe(true);
  });

  test('detects local skills and uses the configured environment and agent directory', async () => {
    const env = { PATH: '/custom/bin' };
    const io = {
      findExecutable: mock(async (_name: string, _path?: string) => undefined),
      exists: mock(async (file: string) => file === '/custom/agent/extensions/pi-superpowers'),
      globalPackages: mock(async () => ''),
    };
    const report = await collectDependencies({ command: 'custom-pi', agentDirectory: '/custom/agent', projectDirectory: '/project', env }, io);
    expect(io.findExecutable).toHaveBeenCalledWith('custom-pi', '/custom/bin');
    expect(io.globalPackages).toHaveBeenCalledWith(env);
    expect(report.find(item => item.name === 'pi-superpowers')?.ok).toBe(true);
    expect(report.find(item => item.name === 'pi-caveman')?.ok).toBe(false);
  });

  test('package names match exactly instead of matching a longer package prefix', () => {
    expect(hasPackage('├── pi-superpowers-extra@1.0', 'pi-superpowers')).toBe(false);
    expect(hasPackage('└── pi-superpowers@1.0', 'pi-superpowers')).toBe(true);
    expect(hasPackage('├── @earendil-works/pi-coding-agent@1.0', '@earendil-works/pi-coding-agent')).toBe(true);
    expect(hasPackage('other-package', 'pi-superpowers')).toBe(false);
  });

  test('executable lookup rejects directories/non-executable files and supports explicit paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-chat-bin-'));
    try {
      const file = join(dir, 'pi');
      mkdirSync(join(dir, 'directory'));
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o644);
      if (process.platform !== 'win32') expect(await findExecutable('pi', dir)).toBeUndefined();
      expect(await findExecutable('directory', dir)).toBeUndefined();
      chmodSync(file, 0o755);
      expect(await findExecutable('pi', dir)).toBe(file);
      expect(await findExecutable(file, '')).toBe(file);
      expect(await findExecutable('missing', dir)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
