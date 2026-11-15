import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Panel } from './panel.js'
import { Sheet } from './sheet.js'
import { badgeVariants, type Status } from './status.js'
import { LastChange } from './time.js'

export interface RoleProps {
  csrf: string
  path: string
  name: string
  changed: { actor: string, at: string | null, revision: number }
  tools: { name: string, product: string, mark: string, granted: boolean, state: Status, note: string | null }[]
  rawApi: { name: string, product: string, mode: string, off: boolean, allowed: boolean }[]
  members: { people: { href: string, name: string, initials: string, username: string, grants: Status[], state: Status }[], pager: { summary: string, first: string | null, next: string | null } }
  blocked: string | null
  rename: { open: boolean, closeHref: string }
}

function Tools({ csrf, path, name, changed, tools }: Pick<RoleProps, 'csrf' | 'path' | 'name' | 'changed' | 'tools'>) {
  return (
    <Panel title="Tools this role grants" description="Changes apply to every member on their next call.">
      <ActionForm action={path + '/tools'} method="PUT" csrf={csrf} trackChanges
        confirmation={{ consequence: `Replace ${name}’s tool grants? Changes apply to every member on the next call.`, action: 'Save tools' }}>
        <VStack gap={3}>
          <Revision value={changed.revision} />
          <fieldset className="tiles">
            <legend className="sr-only">Granted tools</legend>
            <input name="tools" type="hidden" disabled data-type="array" />
            {tools.map(tool => (
              <label key={tool.name} className="tile">
                <input type="checkbox" name="tools" value={tool.name} defaultChecked={tool.granted} />
                <span className="tool-ico" aria-hidden="true">{tool.mark}</span>
                <span className="tile-text">
                  <strong>{tool.product}</strong>
                  <span className="status"><span className={`dot ${tool.state.tone}`} aria-hidden="true" />{tool.state.word}{tool.note && <span className="hint">· {tool.note}</span>}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
            <Text type="supporting">Saving replaces the whole selection. A tool must also be enabled before members can run it.</Text>
            <HStack gap={2}>
              <Button type="submit" label="Save tools" variant="primary" size="sm" />
              <Button type="reset" label="Discard" variant="ghost" size="sm" data-discard="" hidden />
            </HStack>
          </HStack>
        </VStack>
      </ActionForm>
    </Panel>
  )
}

function RawApi({ csrf, path, name, changed, rawApi }: Pick<RoleProps, 'csrf' | 'path' | 'name' | 'changed' | 'rawApi'>) {
  return (
    <Panel title="Raw API access" description="Lets members make raw API calls through the tools below. The tool’s Raw API mode sets what those calls may do.">
      {rawApi.length ? (
        <VStack gap={3}>
          {rawApi.map(tool => (
            <HStack key={tool.name} gap={3} justify="between" vAlign="center" wrap="wrap">
              <VStack gap={0.5}>
                <Text type="label">{tool.product}</Text>
                <Text type="supporting">{`Tool mode: ${tool.mode}.${tool.off ? ' Members cannot make raw calls until an administrator changes it.' : ''}`}</Text>
              </VStack>
              <ActionForm className="row" action={`${path}/tools/${tool.name}/raw-api`} method="PUT" csrf={csrf}
                confirmation={{ consequence: `Change ${name}’s Raw API access to ${tool.product}? Changes apply to every member on the next call.`, action: 'Save access' }}>
                <Revision value={changed.revision} />
                <label className="switch-row">
                  <input type="checkbox" className="switch" role="switch" name="enabled" data-type="boolean" aria-label={`Allow Raw API for ${tool.product}`} defaultChecked={tool.allowed} />
                  <span>Allow</span>
                </label>
                <Button type="submit" label="Save" variant="secondary" size="sm" />
              </ActionForm>
            </HStack>
          ))}
        </VStack>
      ) : <Text as="p" type="supporting">Grant a tool with raw API routes to offer this.</Text>}
    </Panel>
  )
}

function Members({ name, members: { people, pager } }: Pick<RoleProps, 'name' | 'members'>) {
  return (
    <Panel title="Members" description="Give or remove this role on a person’s page, or map it from SSO groups with a role rule.">
      {people.length ? (
        <>
          <Table aria-label={`Members of ${name}`} scrollWrapper={({ children }) => <div className="table-wrap link-rows people-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>{['Name', 'How', 'Status'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}</TableRow>
            </TableHeader>
            <TableBody>
              {people.map(person => (
                <TableRow key={person.href}>
                  <TableHeaderCell scope="row">
                    <HStack gap={2} vAlign="center">
                      <span className="avatar" aria-hidden="true">{person.initials}</span>
                      <VStack gap={0}>
                        <a className="row-link" href={person.href}><strong>{person.name}</strong></a>
                        <Text type="supporting">{person.username}</Text>
                      </VStack>
                    </HStack>
                  </TableHeaderCell>
                  <TableCell><HStack gap={1} wrap="wrap">{person.grants.map(grant => <Badge key={grant.word} label={grant.word} variant={badgeVariants[grant.tone]} />)}</HStack></TableCell>
                  <TableCell><Badge label={person.state.word} variant={badgeVariants[person.state.tone]} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <HStack gap={3} justify="between" vAlign="center">
            <Text type="supporting">{pager.summary}</Text>
            <nav aria-label="Pages">
              <HStack gap={2}>
                <Button href={pager.first ?? undefined} isDisabled={!pager.first} label="First" variant="secondary" size="sm" />
                <Button href={pager.next ?? undefined} isDisabled={!pager.next} label="Next" variant="secondary" size="sm" />
              </HStack>
            </nav>
          </HStack>
        </>
      ) : <Text as="p" type="supporting">No members yet. Give this role to people on their page in People.</Text>}
    </Panel>
  )
}

function Delete({ csrf, path, name, changed, blocked }: Pick<RoleProps, 'csrf' | 'path' | 'name' | 'changed' | 'blocked'>) {
  return (
    <Panel title="Delete role" description={blocked ?? 'Deletes the role and its tool grants. This cannot be undone.'}
      actions={blocked ? <Button label="Delete…" variant="destructive" size="sm" isDisabled /> : (
        <ActionForm action={path} method="DELETE" csrf={csrf} successUrl="/admin/roles" successMessage="Role deleted."
          confirmation={{ consequence: `Delete ${name}? Its tool grants will be removed. This cannot be undone.`, action: 'Delete role', typedName: name }}>
          <Revision value={changed.revision} />
          <Button type="submit" label="Delete…" variant="destructive" size="sm" />
        </ActionForm>
      )} />
  )
}

function RenameSheet({ csrf, path, changed, name, rename }: Pick<RoleProps, 'csrf' | 'path' | 'changed' | 'name' | 'rename'>) {
  const [draft, setDraft] = useState(name)
  return (
    <Sheet name="rename-role" open={rename.open} closeHref={rename.closeHref} title="Rename role" description="Renaming keeps its members and grants."
      submit="Rename" action={path} method="PATCH" csrf={csrf} successMessage="Role renamed.">
      <Revision value={changed.revision} />
      <TextInput label="Role name" htmlName="name" value={draft} onChange={setDraft} autoComplete="off" {...{ required: true }} />
    </Sheet>
  )
}

export function Role(props: RoleProps) {
  return (
    <VStack gap={4}>
      <LastChange {...props.changed} />
      <Tools {...props} />
      <RawApi {...props} />
      <Members {...props} />
      <Delete {...props} />
      <RenameSheet {...props} />
    </VStack>
  )
}
