import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Token } from '@astryxdesign/core/Token'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { Icon } from './icon.js'
import { Sheet, sheetTrigger } from './sheet.js'

const visibleTools = 4

export interface RolesProps {
  roles: { href: string, name: string, tools: { name: string, enabled: boolean }[], members: number, rules: number }[]
  pager: { summary: string, first: string | null, next: string | null }
  newRole: { open: boolean, closeHref: string, csrf: string }
}

function Tools({ tools }: { tools: RolesProps['roles'][number]['tools'] }) {
  if (!tools.length) return <Text type="supporting">No tools yet</Text>
  const shown = tools.length > visibleTools ? visibleTools - 1 : visibleTools
  const rest = tools.slice(shown).map(tool => tool.name).join(', ')
  return (
    <HStack gap={1} wrap="wrap">
      {tools.slice(0, shown).map(tool => tool.enabled
        ? <Token key={tool.name} label={tool.name} />
        : <span key={tool.name} title="Tool disabled"><Token label={tool.name} icon={<span className="dot off" aria-hidden="true" />} /><VisuallyHidden> (disabled)</VisuallyHidden></span>)}
      {rest && <span title={rest}><Token label={`+${tools.length - shown}`} /><VisuallyHidden> more: {rest}</VisuallyHidden></span>}
    </HStack>
  )
}

function NewRoleSheet({ open, closeHref, csrf }: RolesProps['newRole']) {
  const [name, setName] = useState('')
  return (
    <Sheet name="new-role" open={open} closeHref={closeHref} title="New role" description="Name it for the people who need it, such as Read-only analysts. You choose its tools next."
      submit="Create role" action="/v1/admin/roles" csrf={csrf} successUrl="/admin/roles/{id}" successMessage="Role created. Choose the tools it grants.">
      <TextInput label="Role name" htmlName="name" value={name} onChange={setName} autoComplete="off" {...{ required: true }} />
    </Sheet>
  )
}

export function Roles({ roles, pager, newRole }: RolesProps) {
  return (
    <VStack gap={4}>
      {roles.length ? (
        <Card padding={0}>
          <VisuallyHidden as="h2">Roles</VisuallyHidden>
          <Table aria-label="Roles and tool grants" scrollWrapper={({ children }) => <div className="table-wrap link-rows roles-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell scope="col">Role</TableHeaderCell>
                <TableHeaderCell scope="col">Tools</TableHeaderCell>
                <TableHeaderCell scope="col" className="count">Members</TableHeaderCell>
                <TableHeaderCell scope="col" className="count">SSO rules</TableHeaderCell>
                <TableHeaderCell scope="col"><VisuallyHidden>Open</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map(role => (
                <TableRow key={role.href}>
                  <TableHeaderCell scope="row"><a className="row-link" href={role.href}><strong>{role.name}</strong></a></TableHeaderCell>
                  <TableCell><Tools tools={role.tools} /></TableCell>
                  <TableCell className="count" data-label="Members">{role.members}</TableCell>
                  <TableCell className={role.rules ? 'count' : 'count faint'} data-label="SSO rules">{role.rules}</TableCell>
                  <TableCell className="num"><Icon name="chev" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <HStack className="card-note" gap={2} vAlign="center">
            <span className="dot off" aria-hidden="true" />
            <Text type="supporting">Grey dot: the tool is disabled, so members can't use it yet.</Text>
          </HStack>
          <HStack className="card-foot" gap={3} justify="between" vAlign="center">
            <Text type="supporting">{pager.summary}</Text>
            <nav aria-label="Pages">
              <HStack gap={2}>
                <Button href={pager.first ?? undefined} isDisabled={!pager.first} label="First" variant="secondary" size="sm" />
                <Button href={pager.next ?? undefined} isDisabled={!pager.next} label="Next" variant="secondary" size="sm" />
              </HStack>
            </nav>
          </HStack>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No roles yet" headingLevel={2} description="A role is a set of tools. Create one, choose its tools, then give it to people."
            actions={<Button href="/admin/roles?sheet=new-role" label="New role" variant="primary" icon={<Icon name="plus" />} {...sheetTrigger('sheet-new-role', false)} />} />
        </Card>
      )}
      <NewRoleSheet {...newRole} />
    </VStack>
  )
}
