import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface SshAuditStream { text: string | null, counts: string }
export interface SshAuditExecution {
  id: string
  host: string
  account: string
  sudo: boolean
  command: string
  outcome: Status
  startedAt: string
  finishedAt: string | null
  remoteExit: string
  termination: string
  requestId: string
  samples: string
  stdout: SshAuditStream | null
  stderr: SshAuditStream | null
  diagnostic: string | null
  record: string
}
export interface SshAuditProps {
  executions: SshAuditExecution[]
  older: string | null
  connections: { id: number, time: string, event: string, host: string, sudo: boolean, user: string, connection: string, family: string, binding: string }[]
  denials: { time: string, user: string | null, requestId: string | null, outcome: string }[]
}

function Mono({ children }: { children: string }) {
  return <span className="mono">{children}</span>
}

function Stream({ name, stream }: { name: string, stream: SshAuditStream | null }) {
  return (
    <VStack gap={1}>
      <Heading level={4}>{name}</Heading>
      {stream?.text ? <pre className="code">{stream.text}</pre> : <Text as="p" type="supporting">{stream ? 'No retained text.' : 'No retained output.'}</Text>}
      {stream && <Text as="p" type="supporting">{stream.counts}</Text>}
    </VStack>
  )
}

function Execution({ execution }: { execution: SshAuditExecution }) {
  const headingId = `execution-${execution.id}`
  return (
    <article className="execution" aria-labelledby={headingId}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={3} id={headingId}><Mono>{execution.id}</Mono></Heading>
          <Badge label={execution.outcome.word} variant={badgeVariants[execution.outcome.tone]} />
          {execution.sudo && <Badge label="Sudo" variant="warning" />}
        </HStack>
        <MetadataList columns="multi" label={{ position: 'top' }}>
          <MetadataListItem label="Host">{execution.host}</MetadataListItem>
          <MetadataListItem label="Account">{execution.account}</MetadataListItem>
          <MetadataListItem label="Started"><Time iso={execution.startedAt} /></MetadataListItem>
          <MetadataListItem label="Finished"><Time iso={execution.finishedAt} empty="Not finished" /></MetadataListItem>
          <MetadataListItem label="Remote exit">{execution.remoteExit}</MetadataListItem>
          <MetadataListItem label="Termination">{execution.termination}</MetadataListItem>
          <MetadataListItem label="Request ID"><Mono>{execution.requestId}</Mono></MetadataListItem>
          <MetadataListItem label="Output samples">{execution.samples}</MetadataListItem>
        </MetadataList>
        <VStack gap={1}>
          <Heading level={4}>Command</Heading>
          <pre className="code">{execution.command}</pre>
        </VStack>
        {execution.diagnostic && (
          <VStack gap={1}>
            <Heading level={4}>Diagnostic</Heading>
            <pre className="code">{execution.diagnostic}</pre>
          </VStack>
        )}
        <Stream name="Standard output" stream={execution.stdout} />
        <Stream name="Standard error" stream={execution.stderr} />
        <details className="all-fields">
          <summary className="btn btn-secondary btn-sm">Show the full stored record</summary>
          <pre className="code">{execution.record}</pre>
        </details>
      </VStack>
    </article>
  )
}

export function SshAudit({ executions, older, connections, denials }: SshAuditProps) {
  return (
    <VStack gap={4}>
      <Panel title="Retained executions" description="Output is untrusted text. Samples expire after 14 days; metadata expires after 90 days. Exports omit output.">
        {executions.length ? <VStack gap={4} className="executions">{executions.map(execution => <Execution key={execution.id} execution={execution} />)}</VStack>
          : <Text as="p">No retained SSH executions.</Text>}
        {older && <HStack><Button href={older} label="Older executions" variant="secondary" size="sm" /></HStack>}
      </Panel>
      <Panel title="Recent connections and denials" description="Latest 100 connection events and denials.">
        <VStack gap={4}>
          <VStack gap={2}>
            <Heading level={3}>Connection events</Heading>
            {connections.length ? (
              <Table aria-label="Connection events" scrollWrapper={({ children }) => <div className="table-wrap audit-list ssh-events">{children}</div>}>
                <TableHeader>
                  <TableRow isHeaderRow>
                    {['Time', 'Event', 'Host', 'User', 'Connection'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map(event => (
                    <TableRow key={event.id}>
                      <TableHeaderCell scope="row"><Time iso={event.time} /></TableHeaderCell>
                      <TableCell data-label="Event">
                        <HStack gap={2} vAlign="center" wrap="wrap"><Mono>{event.event}</Mono>{event.sudo && <Badge label="Sudo" variant="warning" />}</HStack>
                      </TableCell>
                      <TableCell data-label="Host">{event.host}</TableCell>
                      <TableCell data-label="User"><Mono>{event.user}</Mono></TableCell>
                      <TableCell className="connection-cell">
                        <div><Mono>{event.connection}</Mono></div>
                        <div className="event-detail">Session family <Mono>{event.family}</Mono></div>
                        <div className="event-detail">Binding <Mono>{event.binding}</Mono></div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <Text as="p" type="supporting">No retained connection events.</Text>}
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>Denials</Heading>
            {denials.length ? (
              <Table aria-label="Denials" scrollWrapper={({ children }) => <div className="table-wrap audit-list ssh-events">{children}</div>}>
                <TableHeader>
                  <TableRow isHeaderRow>
                    {['Time', 'User', 'Request ID', 'Outcome'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {denials.map((denial, index) => (
                    <TableRow key={index}>
                      <TableHeaderCell scope="row"><Time iso={denial.time} /></TableHeaderCell>
                      <TableCell data-label="User">{denial.user ? <Mono>{denial.user}</Mono> : <Text type="supporting">System</Text>}</TableCell>
                      <TableCell data-label="Request ID">{denial.requestId ? <Mono>{denial.requestId}</Mono> : <Text type="supporting">-</Text>}</TableCell>
                      <TableCell data-label="Outcome">{denial.outcome}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <Text as="p" type="supporting">No retained denials.</Text>}
          </VStack>
        </VStack>
      </Panel>
    </VStack>
  )
}
