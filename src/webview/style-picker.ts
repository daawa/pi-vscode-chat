import * as vscode from 'vscode';
import type { ChatStyle, PostMessage } from '../webview-types.ts';

export async function selectStyle(currentStyle: ChatStyle, postMessage: PostMessage): Promise<void> {
  const styles: (vscode.QuickPickItem & { style: ChatStyle })[] = [
    { label: 'Default', detail: 'Uses VS Code theme colors.', style: 'default' },
    { label: 'Custom', detail: 'Tinted tool results and light blue code blocks.', style: 'custom' },
  ];
  const picked = await vscode.window.showQuickPick(
    styles.map(item => ({ ...item, description: item.style === currentStyle ? 'Current' : undefined })),
    { title: 'Chat style', placeHolder: 'Select a style for Pi Chat' },
  );
  if (picked) postMessage({ type: 'styleSelected', style: picked.style });
}
