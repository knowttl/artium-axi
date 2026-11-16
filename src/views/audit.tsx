import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useState } from 'react'
import { Icon } from './icon.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface AuditProps {
  filters: {
    requestId: string
    delegationId: string
    range: { label: string, href: string, current: boolean }[]
    failed: { on: boolean, href: string }
    chips: { name: string, label: string, value: string, clearHref: string | null, options: { value: string, text: string }[] }[]
    errorCode: { value: string, clearHref: string } | null
    hidden: { name: string, value: string }[]
    custom: { from: string, to: string } | null
    clear: boolean
  }
  exports: { csv: string, jsonl: string }
  rows: { href: string, current: boolean, time: string, event: string, breakGlass: boolean, actor: string | null, tool: string | null, instance: string | null, outcome: Status }[]
  pager: { summary: string, newest: string | null, older: string | null }
  detail: string | null
}

function Chip({ name, label, value, clearHref, options }: AuditProps['filters']['chips'][number]) {
  return (
    <span className={`filter${value ? ' set' : ''}`}>
      {value ? <span>{label}</span> : <Icon name="plus" />}
      <select name={name} aria-label={label} defaultValue={value}>
        <option value="">{label}</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.text}</option>)}
      </select>
      {clearHref && <a href={clearHref} aria-label={`Clear ${label.toLowerCase()} filter`}><Icon name="x" /></a>}
    </span>
  )
}

function Filters({ requestId, delegationId, range, failed, chips, errorCode, hidden, custom, clear }: AuditProps['filters']) {
  const [request, setRequest] = useState(requestId)
  const [delegation, setDelegation] = useState(delegationId)
  const [from, setFrom] = useState(custom?.from ?? '')
  const [to, setTo] = useState(custom?.to ?? '')
  return (
    <form className="filters" method="get" action="/admin/audit" data-filters>
      <TextInput label="Request ID" isLabelHidden htmlName="requestId" value={request} onChange={setRequest} size="sm" width={180} startIcon={<Icon name="search" />}
        placeholder="Request ID" {...{ maxLength: 100 }} />
      <TextInput label="Token ID" isLabelHidden htmlName="delegationId" value={delegation} onChange={setDelegation} size="sm" width={180} placeholder="Token ID" />
      <HStack gap={1} role="group" aria-label="Time range">
        {range.map(link => <Button key={link.label} href={link.href} label={link.label} variant={link.current ? 'secondary' : 'ghost'} size="sm"
          {...{ 'aria-current': link.current ? 'true' : undefined }} />)}
      </HStack>
      {failed.on
        ? <a className="filter set" href={failed.href} aria-label="Clear filter: Failed runs only"><strong>Failed runs only</strong><Icon name="x" /></a>
        : <a className="filter" href={failed.href}><Icon name="plus" />Failed runs only</a>}
      {chips.map(chip => <Chip key={chip.name} {...chip} />)}
      {errorCode && (
        <span className="filter set">
          <span>Error code</span><strong>{errorCode.value}</strong><input type="hidden" name="errorCode" value={errorCode.value} />
          <a href={errorCode.clearHref} aria-label="Clear error code filter"><Icon name="x" /></a>
        </span>
      )}
      {hidden.map(field => <input key={field.name} type="hidden" name={field.name} value={field.value} />)}
      {custom && (
        <HStack gap={2} vAlign="end" wrap="wrap">
          <TextInput label="From (UTC)" id="audit-from" htmlName="from" value={from} onChange={setFrom} size="sm" width={220} placeholder="2026-01-01T00:00:00Z" controlClassName="mono" />
          <TextInput label="To (UTC)" id="audit-to" htmlName="to" value={to} onChange={setTo} size="sm" width={220} placeholder="2026-01-31T23:59:59Z" controlClassName="mono" />
        </HStack>
      )}
      <Button type="submit" label="Apply" variant="secondary" size="sm" {...custom ? {} : { 'data-filters-apply': '' }} />
      {clear && <Button href="/admin/audit" label="Clear filters" variant="ghost" size="sm" />}
    </form>
  )
}

function ExportMenu({ csv, jsonl }: AuditProps['exports']) {
  return (
    <details className="menu">
      <summary className="btn btn-secondary"><Icon name="download" />Export<Icon name="chevd" /></summary>
      <div className="popover">
        <p className="popover-note">Uses the current filters. Downloads include all retained records matching the applied filters, across every page.</p>
        <a download href={csv}><Icon name="download" />CSV</a>
        <a download href={jsonl}><Icon name="download" />JSON lines</a>
      </div>
    </details>
  )
}

function Rows({ rows }: Pick<AuditProps, 'rows'>) {
  return (
    <Table aria-label="Audit records" scrollWrapper={({ children }) => <div className="table-wrap link-rows audit-list">{children}</div>}>
      <TableHeader>
        <TableRow isHeaderRow>
          {['Time', 'Event', 'Actor', 'Tool', 'Instance', 'Outcome'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(row => (
          <TableRow key={row.href} className={row.current ? 'sel' : undefined}>
            <TableHeaderCell scope="row">
              <a className="row-link" href={row.href} aria-current={row.current ? 'true' : undefined}><Time iso={row.time} /></a>
            </TableHeaderCell>
            <TableCell data-label="Event">
              <span className="mono">{row.event}</span>
              {row.breakGlass && <>{' '}<Badge label="Break-glass" variant="warning" /></>}
            </TableCell>
            <TableCell data-label="Actor">{row.actor ?? <Text type="supporting">System</Text>}</TableCell>
            <TableCell data-label="Tool">{row.tool ?? <Text type="supporting">-</Text>}</TableCell>
            <TableCell data-label="Instance">{row.instance ?? <Text type="supporting">default/unknown</Text>}</TableCell>
            <TableCell><Badge label={row.outcome.word} variant={badgeVariants[row.outcome.tone]} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function AuditLog({ filters, exports, rows, pager, detail }: AuditProps) {
  return (
    <div className={`split${detail ? ' has-aside' : ''}`}>
      <div className="split-main">
        <div className="audit-toolbar">
          <Filters {...filters} />
          <ExportMenu {...exports} />
        </div>
        {rows.length ? (
          <Card padding={0}>
            <Rows rows={rows} />
            <HStack className="card-foot" gap={3} justify="between" vAlign="center">
              <Text type="supporting">{pager.summary}</Text>
              <HStack gap={2} role="navigation" aria-label="Pages">
                <Button href={pager.newest ?? undefined} isDisabled={!pager.newest} label="Newest" variant="secondary" size="sm" />
                <Button href={pager.older ?? undefined} isDisabled={!pager.older} label="Older" variant="secondary" size="sm" />
              </HStack>
            </HStack>
          </Card>
        ) : (
          <Card>
            <EmptyState title="No audit records match these filters." headingLevel={2} description="Widen the time range or clear a filter."
              actions={filters.clear ? <Button href="/admin/audit" label="Clear filters" variant="secondary" /> : undefined} />
          </Card>
        )}
      </div>
      {detail && <div className="legacy-island audit-detail" dangerouslySetInnerHTML={{ __html: detail }} />}
    </div>
  )
}
