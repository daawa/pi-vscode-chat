import * as vscode from 'vscode';
import type { ChatStyle, PostMessage } from '../webview-types.ts';

export async function selectStyle(currentStyle: ChatStyle, postMessage: PostMessage): Promise<void> {
  const styles: (vscode.QuickPickItem & { style: ChatStyle })[] = [
    { label: 'Default', detail: 'Uses VS Code theme colors.', style: 'default' },
    { label: 'Custom', detail: 'Tinted tool results and light blue code blocks.', style: 'custom' },
  ];
  const picked = await vscode.window.showQuickPick(
    styles
      .map(item => ({
        ...item,
        label: item.style === currentStyle ? `$(check) ${item.label}` : item.label,
        description: item.style === currentStyle ? 'Currently selected' : undefined,
      }))
      // showQuickPick focuses the first item; keep that aligned with the active style.
      .sort((a, b) => Number(b.style === currentStyle) - Number(a.style === currentStyle)),
    { title: 'Chat style', placeHolder: 'Select a style for Pi Chat' },
  );
  if (picked) postMessage({ type: 'styleSelected', style: picked.style });
}
