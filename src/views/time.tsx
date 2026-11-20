import { Text } from '@astryxdesign/core/Text'
import { useClientValue } from './client-value.js'

function LocalTime({ iso }: { iso: string }) {
  const text = useClientValue(() => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), iso)
  return <time dateTime={iso} title={iso}>{text}</time>
}

export function Time({ iso, empty = 'Not recorded' }: { iso: string | null, empty?: string }) {
  return iso === null ? <>{empty}</> : <LocalTime iso={iso} />
}

export function LastChange({ actor, at, revision }: { actor: string, at: string | null, revision: number }) {
  return <Text className="card-meta" as="p" type="supporting">{`Last changed by ${actor} at `}<Time iso={at} />{`. Revision ${revision}.`}</Text>
}
