import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { Icon } from './icon.js'
import { badgeVariants, type Status } from './status.js'

export interface PeopleProps {
  filters: { q: string, limit: number, selects: { name: string, label: string, value: string, options: [string, string][] }[], clear: boolean, count: string }
  people: { href: string, name: string, initials: string, username: string, you: boolean, signIn: Status, administrator: boolean, roles: { href: string, label: string }[], status: Status, enabled: boolean }[]
  empty: string
  pager: { summary: string, first: string | null, next: string | null }
  sheet: string
}

function Filters({ q, limit, selects, clear, count }: PeopleProps['filters']) {
  const [query, setQuery] = useState(q)
  return (
    <form className="filters" method="get" action="/admin/users" data-filters>
      <TextInput label="Search" isLabelHidden type="search" htmlName="q" value={query} onChange={setQuery} size="sm" width={300} startIcon={<Icon name="search" />}
        placeholder="Search name or username" {...{ maxLength: 256 }} />
      {selects.map(select => (
        <label key={select.name} className={`filter${select.value ? ' set' : ''}`}>
          {!select.value && <Icon name="plus" />}
          <span>{select.label}</span>
          <select name={select.name} defaultValue={select.value}>
            <option value="">Any</option>
            {select.options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
      ))}
      <input type="hidden" name="limit" value={limit} />
      <Button type="submit" label="Apply" variant="secondary" size="sm" data-filters-apply="" />
      {clear && <Button href="/admin/users" label="Clear" variant="ghost" size="sm" />}
      <Text className="count-note" type="supporting">{count}</Text>
    </form>
  )
}

export function People({ filters, people, empty, pager, sheet }: PeopleProps) {
  return (
    <VStack gap={4}>
      <Filters {...filters} />
      {people.length ? (
        <Card padding={0}>
          <VisuallyHidden as="h2">People</VisuallyHidden>
          <Table aria-label="People" scrollWrapper={({ children }) => <div className="table-wrap link-rows people-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Name', 'Sign-in', 'Roles', 'Status'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                <TableHeaderCell scope="col"><VisuallyHidden>Open</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map(person => (
                <TableRow key={person.href} className={person.enabled ? undefined : 'dim'}>
                  <TableCell>
                    <HStack gap={2} vAlign="center">
                      <span className="avatar" aria-hidden="true">{person.initials}</span>
                      <VStack gap={0}>
                        <a className="row-link" href={person.href}><strong>{person.name}</strong></a>
                        <Text type="supporting">{person.username}{person.you ? ' · you' : ''}</Text>
                      </VStack>
                    </HStack>
                  </TableCell>
                  <TableCell>
                    <HStack gap={1} wrap="wrap">
                      <Badge label={person.signIn.word} variant={badgeVariants[person.signIn.tone]} />
                      {person.administrator && <Badge label="Admin" variant="neutral" />}
                    </HStack>
                  </TableCell>
                  <TableCell>
                    {person.roles.length
                      ? <HStack gap={1} wrap="wrap">{person.roles.map(role => <Token key={role.href} className="row-chip" href={role.href} label={role.label} />)}</HStack>
                      : <Text type="supporting">No roles</Text>}
                  </TableCell>
                  <TableCell><Badge label={person.status.word} variant={badgeVariants[person.status.tone]} /></TableCell>
                  <TableCell className="num"><Icon name="chev" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <HStack className="card-foot" gap={3} justify="between" vAlign="center">
            <Text type="supporting">{pager.summary}</Text>
            <HStack gap={2}>
              <Button href={pager.first ?? undefined} isDisabled={!pager.first} label="First page" variant="secondary" size="sm" />
              <Button href={pager.next ?? undefined} isDisabled={!pager.next} label="Next" variant="secondary" size="sm" />
            </HStack>
          </HStack>
        </Card>
      ) : <Card><EmptyState title="No matching people" description={empty} headingLevel={2} /></Card>}
      <div dangerouslySetInnerHTML={{ __html: sheet }} />
    </VStack>
  )
}
