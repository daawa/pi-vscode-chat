// ── Edit Tracking ──

export interface EditRecord {
  id: string;
  filePath: string;
  originalContent: string;
  originalExists: boolean;
  newContent: string;
  diff: string;
  timestamp: number;
  status: 'pending' | 'accepted' | 'reverted';
}
