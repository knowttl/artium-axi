import { Text } from '@astryxdesign/core/Text'

export function Time({ iso, empty = 'Not recorded' }: { iso: string | null, empty?: string }) {
  return iso === null ? <>{empty}</> : <time dateTime={iso} title={iso} suppressHydrationWarning>{iso}</time>
}

export function LastChange({ actor, at, revision }: { actor: string, at: string | null, revision: number }) {
  return <Text className="card-meta" as="p" type="supporting">{`Last changed by ${actor} at `}<Time iso={at} />{`. Revision ${revision}.`}</Text>
}
