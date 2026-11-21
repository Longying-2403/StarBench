export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors that crossed IPC; the prefix is noise for the user.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
