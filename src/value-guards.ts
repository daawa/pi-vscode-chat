/** Narrow parsed JSON at process, filesystem and webview boundaries. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
