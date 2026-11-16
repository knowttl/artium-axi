import { Badge } from '@astryxdesign/core/Badge'
import { IconButton } from '@astryxdesign/core/IconButton'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { Icon } from './icon.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface AuditDetailProps {
  closeHref: string
  id: string
  record: {
    heading: string
    time: string
    number: number
    facts: { actor: string, tool: string, instance: string | null, outcome: Status, requestId: string, clientAddress: string, signInMethod: string, action: string | null, errorCode: string | null }
    settingsChanges: { path: string, text: string }[]
    diagnostic: string | null
    fields: { name: string, value: string | null, time: boolean }[]
  } | null
}

function Mono({ children }: { children: string }) {
  return <span className="mono">{children}</span>
}

export function AuditDetail({ closeHref, id, record }: AuditDetailProps) {
  return (
    <aside className="sheet docked" id="record" aria-labelledby="record-title">
      <div className="sheet-head">
        <div>
          <Heading level={2} id="record-title">{record ? record.heading : 'Record not found'}</Heading>
          <Text as="p" type="supporting">
            {record ? <><Time iso={record.time} />{` · #${record.number}`}</> : `Record #${id} is no longer retained or does not exist.`}
          </Text>
        </div>
        <IconButton href={closeHref} label="Close details" icon={<Icon name="x" />} variant="ghost" size="sm" />
      </div>
      {record && (
        <div className="sheet-body">
          <MetadataList columns="single">
            <MetadataListItem label="Actor">{record.facts.actor}</MetadataListItem>
            <MetadataListItem label="Tool">{record.facts.tool}</MetadataListItem>
            {record.facts.instance && <MetadataListItem label="Instance">{record.facts.instance}</MetadataListItem>}
            <MetadataListItem label="Outcome"><Badge label={record.facts.outcome.word} variant={badgeVariants[record.facts.outcome.tone]} /></MetadataListItem>
            <MetadataListItem label="Request ID">
              <span className="copyfield" data-copy-scope="">
                <input className="input" readOnly value={record.facts.requestId} aria-label="Request ID" />
                <IconButton type="button" label="Copy request ID" icon={<Icon name="copy" />} variant="ghost" size="sm" data-copy="" />
                <span className="sr-only" data-copy-status="" role="status" />
              </span>
            </MetadataListItem>
            <MetadataListItem label="Client address">{record.facts.clientAddress}</MetadataListItem>
            <MetadataListItem label="Sign-in method">{record.facts.signInMethod}</MetadataListItem>
            {record.facts.action && <MetadataListItem label="Action"><Mono>{record.facts.action}</Mono></MetadataListItem>}
            {record.facts.errorCode && <MetadataListItem label="Error code"><Mono>{record.facts.errorCode}</Mono></MetadataListItem>}
          </MetadataList>
          {record.settingsChanges.length > 0 && (
            <VStack gap={2}>
              <Heading level={3}>Settings changes</Heading>
              <MetadataList columns="single" label={{ position: 'top' }}>
                {record.settingsChanges.map((change, index) => (
                  <MetadataListItem key={index} label={change.path}><pre className="code">{change.text}</pre></MetadataListItem>
                ))}
              </MetadataList>
            </VStack>
          )}
          {record.diagnostic && (
            <VStack gap={2}>
              <Heading level={3}>Failure diagnostic</Heading>
              <pre className="code">{record.diagnostic}</pre>
            </VStack>
          )}
          <details className="all-fields">
            <summary className="btn btn-secondary btn-sm">{`Show all ${record.fields.length} stored fields`}</summary>
            <MetadataList columns="single" label={{ position: 'top' }}>
              {record.fields.map(field => (
                <MetadataListItem key={field.name} label={field.name}>
                  {field.value === null ? 'Not recorded' : field.time ? <Time iso={field.value} /> : field.value}
                </MetadataListItem>
              ))}
            </MetadataList>
          </details>
        </div>
      )}
    </aside>
  )
}
