import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isRecord } from '../value-guards.ts';
import type { PiRpcClient } from '../pi-rpc-client.ts';

/** One picker/auth source for the sidebar and command palette. */
export class ModelService {
  constructor(
    private readonly pi: PiRpcClient,
    private readonly agentDirectory: string,
    private readonly onModelChanged: () => Promise<void>,
  ) {}

  async selectModel(notify = false): Promise<void> {
    const models = await this.pi.getModels();
    if (models.length === 0) {
      vscode.window.showErrorMessage('No models available. Check pi configuration.');
      return;
    }

    // Filter models: only show those from authenticated providers
    const authProviders = await this.getAuthenticatedProviders();
    const filtered = authProviders.length > 0
      ? models.filter((m) => authProviders.includes(m.provider))
      : models; // if auth.json missing or empty, show all (fallback)

    if (filtered.length === 0) {
      vscode.window.showErrorMessage('No models from authenticated providers. Run pi /login to add a provider.');
      return;
    }

    const items = filtered.map((m) => ({
      label: m.name || m.id,
      description: `${m.provider}/${m.id}`,
      detail: [
        m.reasoning ? '$(sparkle) reasoning' : undefined,
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined,
        m.cost ? `$${m.cost.input}/${m.cost.output} per MTok` : undefined,
      ].filter(Boolean).join('  ·  '),
      provider: m.provider,
      modelId: m.id,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select model for pi',
      matchOnDescription: true,
    });

    if (picked) {
      if (!await this.pi.setModel(picked.provider, picked.modelId)) throw new Error('Failed to change model');
      await this.onModelChanged();
      if (notify) await vscode.window.showInformationMessage(`Pi: Switched to ${picked.label}`);
    }
  }

  async getAuthenticatedProviders(): Promise<string[]> {
    try {
      const auth: unknown = JSON.parse(await readFile(path.join(this.agentDirectory, 'auth.json'), 'utf8'));
      return isRecord(auth) ? Object.keys(auth) : [];
    } catch { return []; } // Missing/unreadable credentials: retain the all-models fallback.
  }
}
