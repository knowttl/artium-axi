import { Text } from '@astryxdesign/core/Text'
import { useClientValue } from './client-value.js'

function LocalTime({ iso, attributes }: { iso: string, attributes?: Record<string, string> }) {
  const text = useClientValue(() => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), iso)
  return <time {...attributes} dateTime={iso} title={iso}>{text}</time>
}

export function Time({ iso, empty = 'Not recorded', attributes }: { iso: string | null, empty?: string, attributes?: Record<string, string> }) {
  return iso === null ? <>{empty}</> : <LocalTime iso={iso} attributes={attributes} />
}

export function LastChange({ actor, at, revision }: { actor: string, at: string | null, revision: number }) {
  return <Text className="card-meta" as="p" type="supporting">{`Last changed by ${actor} at `}<Time iso={at} />{`. Revision ${revision}.`}</Text>
}
