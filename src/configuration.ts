import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TransportOptions } from './rpc/transport.ts';

export const LAST_SESSION_FILE_STATE_KEY = 'piChat.lastSessionFile';

export function readLaunchOptions(): TransportOptions {
  const config = vscode.workspace.getConfiguration('piChat');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const configured = config.get<string>('piPath') || 'pi';
  const command = configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2))
    : configured.includes('/') || configured.includes('\\') ? path.resolve(cwd || process.cwd(), configured) : configured;
  return {
    command,
    args: config.get<string[]>('adapterArgs') || [],
    cwd,
    // Preserve the restricted child environment; secrets are opt-in through extraEnv.
    env: {
      ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, HOME: process.env.HOME,
      USER: process.env.USER, SHELL: process.env.SHELL || '/bin/bash',
      TERM: process.env.TERM || 'xterm-256color', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      NODE_ENV: 'production', ...(config.get<Record<string, string>>('extraEnv') || {}),
    },
  };
}

export function getAgentDirectory(env: NodeJS.ProcessEnv = {}, cwd = process.cwd()): string {
  const directory = env.PI_CODING_AGENT_DIR;
  if (!directory) return path.join(homeDirectory(env), '.pi', 'agent');
  return directory.startsWith('~/') ? path.join(homeDirectory(env), directory.slice(2)) : path.resolve(cwd, directory);
}

export function getSessionDirectory(options: TransportOptions): string {
  const args = options.args || [];
  let explicit = options.env?.PI_CODING_AGENT_SESSION_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    if (args[i] === '--session-dir' && i + 1 < args.length) explicit = args[++i];
  }
  if (explicit) {
    if (explicit.startsWith('~/')) return path.join(homeDirectory(options.env), explicit.slice(2));
    return path.resolve(options.cwd || process.cwd(), explicit);
  }
  if (!options.cwd) return '';
  const encoded = options.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return path.join(getAgentDirectory(options.env, options.cwd), 'sessions', `--${encoded}--`);
}

function homeDirectory(env: NodeJS.ProcessEnv = {}): string {
  return (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}
