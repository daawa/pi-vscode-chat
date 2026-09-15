import * as path from 'node:path';
import * as os from 'node:os';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PI_SKILLS = [
  { name: 'context-mode', desc: 'Session-aware context management & history pruning' },
  { name: 'pi-superpowers', desc: 'Step-by-step planning, code review & debugging' },
  { name: 'pi-subagents', desc: 'Multi-agent background delegation' },
  { name: 'pi-agents-team', desc: 'Orchestrated multi-worker agent teams' },
  { name: 'pi-caveman', desc: 'Token compression for fast responses' },
  { name: 'pi-web-access', desc: 'Real-time search and web scraping' },
  { name: 'pi-mcp-adapter', desc: 'Connect to Model Context Protocol (MCP) servers' },
] as const;
export interface DependencyItem { name: string; description: string; ok: boolean; action?: string }
interface DependencyOptions { command: string; projectDirectory: string; agentDirectory: string; env?: NodeJS.ProcessEnv }
interface DependencyIO {
  findExecutable: typeof findExecutable;
  exists: typeof exists;
  globalPackages: typeof readGlobalPackages;
}

export async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/** One executable lookup for startup and dependency reporting. */
export async function findExecutable(name: string, searchPath = process.env.PATH || ''): Promise<string | undefined> {
  const direct = path.isAbsolute(name) || name.includes('/') || name.includes('\\');
  const candidates = direct ? [path.resolve(name)] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const file = candidate + extension;
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch { /* Keep searching. */ }
    }
  }
  return undefined;
}

const execute = promisify(execFile);
export async function readGlobalPackages(env?: NodeJS.ProcessEnv): Promise<string> {
  const options = { timeout: 5000, maxBuffer: 1024 * 1024, env, windowsHide: true };
  try { return (await execute('bun', ['pm', 'ls', '-g'], options)).stdout; }
  catch {
    try { return (await execute('npm', ['ls', '-g', '--depth=0'], options)).stdout; }
    catch { return ''; }
  }
}

export function hasPackage(inventory: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|\\s|[├└─+`])' + escaped + '(?:@|\\s|$)', 'm').test(inventory);
}

/** No synchronous subprocesses; one package inventory is reused for every package/skill. */
export async function collectDependencies(options: DependencyOptions, io: DependencyIO = {
  findExecutable, exists, globalPackages: readGlobalPackages,
}): Promise<DependencyItem[]> {
  const [pi, bun, node, inventory] = await Promise.all([
    io.findExecutable(options.command, options.env?.PATH), io.findExecutable('bun', options.env?.PATH),
    io.findExecutable('node', options.env?.PATH), io.globalPackages(options.env),
  ]);
  const enginePackage = '@earendil-works/pi-coding-agent';
  const installed = hasPackage(inventory, enginePackage);
  const items: DependencyItem[] = [
    { name: 'pi engine', description: pi ? `Found at ${pi}` : 'Not found on PATH', ok: !!pi,
      action: pi ? undefined : `bun add -g ${enginePackage}` },
    { name: 'bun', description: bun ? 'Found' : 'Not found (package manager for pi)', ok: !!bun,
      action: bun ? undefined : 'curl -fsSL https://bun.sh/install | bash' },
    { name: 'node', description: node ? 'Found' : 'Not found', ok: !!node },
    { name: `${enginePackage} (npm global)`, description: installed ? 'Installed globally' : 'Not installed globally', ok: installed,
      action: installed ? undefined : `bun add -g ${enginePackage}` },
  ];
  const directories = [path.join(options.agentDirectory, 'npm', 'node_modules'),
    path.join(options.agentDirectory, 'extensions'), path.join(os.homedir(), '.agents', 'skills')];
  for (const skill of PI_SKILLS) {
    const found = hasPackage(inventory, skill.name) || (await Promise.all(directories.map(dir => io.exists(path.join(dir, skill.name))))).some(Boolean);
    items.push({ name: skill.name, description: found ? 'Installed' : `Not installed — ${skill.desc}`, ok: found,
      action: found ? undefined : `bun add -g ${skill.name}` });
  }
  for (const name of ['marked', 'highlight.js']) {
    const found = await io.exists(path.join(options.projectDirectory, 'node_modules', name));
    items.push({ name: `${name} (build dep)`, description: found ? 'Installed' : 'Not installed — run bun install',
      ok: found, action: found ? undefined : 'bun install' });
  }
  return items;
}
