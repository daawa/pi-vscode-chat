import * as vscode from 'vscode';
import * as path from 'node:path';
import { collectDependencies, exists, PI_SKILLS } from './dependencies.ts';
import { getAgentDirectory, readLaunchOptions } from '../configuration.ts';

export async function configureProvider(): Promise<void> {
  const pick = await vscode.window.showQuickPick([
    { label: '$(sign-in) Login', description: 'pi /login — add or switch provider', cmd: 'pi /login' },
    { label: '$(sign-out) Logout', description: 'pi /logout — remove current provider', cmd: 'pi /logout' },
    { label: '$(refresh) Reload', description: 'Reload window to sync provider state' },
  ], { placeHolder: 'Manage provider authentication' });
  if (!pick) return;
  if (pick.cmd) {
    const terminal = vscode.window.createTerminal({ name: 'pi' });
    terminal.show();
    terminal.sendText(pick.cmd);
  }
  if (await vscode.window.showInformationMessage('Pi Chat: reload to sync provider state.', 'Reload Now') === 'Reload Now') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

export async function manageSkills(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showQuickPick(PI_SKILLS.map(skill => ({
    label: `🧩 ${skill.name}`, description: skill.desc, detail: `Package: ${skill.name}`,
  })), { placeHolder: 'Select a Pi Skill / Extension to inspect or install' });
  if (picked) await runInstall(context);
}

export async function runDependencyCheck(context: vscode.ExtensionContext): Promise<void> {
  const options = readLaunchOptions();
  const items = await collectDependencies({
    command: options.command, env: options.env, agentDirectory: getAgentDirectory(options.env, options.cwd),
    projectDirectory: options.cwd || context.extensionPath,
  });
  const missing = items.filter(item => !item.ok);
  if (!missing.length) {
    const action = await vscode.window.showInformationMessage(`Pi Chat: All ${items.length} dependencies OK. Ready to use.`, 'Open Pi Chat');
    if (action === 'Open Pi Chat') await vscode.commands.executeCommand('workbench.view.extension.pi-chat');
    return;
  }
  const choices: vscode.QuickPickItem[] = [{
    label: `$(package) Install All (${missing.length} missing)`,
    description: 'Run install script for all missing dependencies', alwaysShow: true,
  }, ...missing.map(item => ({ label: `✗ ${item.name}`, description: item.description,
    detail: item.action ? `Run: ${item.action}` : undefined }))];
  const selected = await vscode.window.showQuickPick(choices, {
    placeHolder: `Pi Chat: ${missing.length}/${items.length} dependencies missing. Select action.`,
  });
  if (selected === choices[0]) await runInstall(context);
}

export async function runInstall(context: vscode.ExtensionContext): Promise<void> {
  const script = path.join(context.extensionPath, 'scripts', 'install-deps.sh');
  const terminal = vscode.window.createTerminal({ name: 'Pi Chat Install', message: 'Installing Pi Chat dependencies...' });
  terminal.show();
  if (await exists(script)) {
    terminal.sendText(`bash "${script}"`);
  } else {
    terminal.sendText('# Pi Chat — Installing dependencies');
    terminal.sendText('which bun || curl -fsSL https://bun.sh/install | bash');
    terminal.sendText('bun add -g @earendil-works/pi-coding-agent');
    terminal.sendText('bun add -g context-mode pi-superpowers pi-subagents pi-agents-team pi-caveman pi-web-access pi-mcp-adapter 2>/dev/null; echo "Skills installed (some may not be found — that\'s fine)"');
    terminal.sendText('echo "---"; echo "Pi Chat install complete. Reload VS Code window."');
  }
  await vscode.window.showInformationMessage('Pi Chat: Installing dependencies in terminal. Follow the prompts.');
}
