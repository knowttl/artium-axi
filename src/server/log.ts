type LogValue = string | number | boolean | null | readonly string[]

// Callers supply only fixed tokens, IDs, numbers and sanitized code locations.
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, LogValue | undefined> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, event, requestId: null, ...fields }) + '\n')
}
