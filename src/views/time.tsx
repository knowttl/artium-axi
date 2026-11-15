export function Time({ iso, empty = 'Not recorded' }: { iso: string | null, empty?: string }) {
  return iso === null ? <>{empty}</> : <time dateTime={iso} title={iso} suppressHydrationWarning>{iso}</time>
}
