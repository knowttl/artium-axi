import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Mono } from './mono.js'
import { Panel } from './panel.js'

export interface SshHostRow {
  id: string
  revision: number
  address: string
  port: number
  approvedHostKeys: string
  allowedAddresses: string
  independentVerification: string
  enabled: boolean
  readOnly: boolean
  commandSeconds: number
  outputBytes: number
  idleMinutes: number
}
export interface SshHostsProps {
  csrf: string
  intro: string
  hosts: SshHostRow[]
  credentials: string[]
  users: { id: string, username: string }[]
  bindings: { host: string, sudo: boolean, username: string, credential: string, revision: number }[]
  grants: { host: string, user: string, username: string | null, shell: boolean, sudo: boolean }[]
}

const proof = <input type="hidden" name="confirm" data-type="boolean" value="true" />

function Check({ name, title, checked }: { name: string, title: string, checked: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} data-type="boolean" defaultChecked={checked} />
      <span><strong>{title}</strong></span>
    </label>
  )
}

function HostForm({ csrf, host }: { csrf: string, host?: SshHostRow }) {
  const prefix = host ? `stored-host-${host.id}` : 'new-host'
  const [fields, setFields] = useState({ id: '', address: host?.address ?? '', port: String(host?.port ?? 22), approvedHostKeys: host?.approvedHostKeys ?? '[]',
    allowedAddresses: host?.allowedAddresses ?? '[]', independentVerification: host?.independentVerification ?? '', commandSeconds: String(host?.commandSeconds ?? 600),
    outputBytes: String(host?.outputBytes ?? 65536), idleMinutes: String(host?.idleMinutes ?? 60) })
  type Name = keyof typeof fields
  const text = (name: Name, label: string, type: 'text' | 'number' = 'text') => (
    <TextInput label={label} id={`${prefix}-${name}`} htmlName={name} value={fields[name]} onChange={value => setFields({ ...fields, [name]: value })}
      {...{ required: true, ...type === 'number' ? { pattern: '[0-9]+', 'data-type': 'number' } : {} }} {...type === 'number' ? { inputMode: 'numeric' as const } : {}} />
  )
  const json = (name: 'approvedHostKeys' | 'allowedAddresses', label: string) => (
    <TextArea label={label} id={`${prefix}-${name}`} htmlName={name} value={fields[name]} onChange={value => setFields({ ...fields, [name]: value })} rows={3} hasSpellCheck={false}
      controlClassName="mono" {...{ required: true, 'data-type': 'json' }} />
  )
  return (
    <ActionForm action="/v1/admin/ssh/hosts" method="POST" csrf={csrf}
      confirmation={{ consequence: 'Save this host trust and policy? Existing drafts using its previous revision will become stale.' }}>
      {proof}
      <VStack gap={3}>
        <Revision value={host?.revision ?? 0} />
        {host ? <input type="hidden" name="id" value={host.id} /> : text('id', 'Host ID')}
        {text('address', 'Approved hostname or address')}
        {text('port', 'Port', 'number')}
        {json('approvedHostKeys', 'Independently verified server public keys (JSON array)')}
        {json('allowedAddresses', 'Allowed literal IP addresses (JSON array)')}
        {text('independentVerification', 'Independent verification reference')}
        <Check name="enabled" title="Enable this host" checked={host?.enabled ?? false} />
        <Check name="readOnly" title="Keep this host read only" checked={host?.readOnly ?? true} />
        <div className="ssh-limits">
          {text('commandSeconds', 'Maximum command seconds (1-600)', 'number')}
          {text('outputBytes', 'Maximum output bytes (0-1048576)', 'number')}
          {text('idleMinutes', 'Maximum connection idle minutes (1-60)', 'number')}
        </div>
        <HStack><Button type="submit" label="Save host" variant="primary" /></HStack>
      </VStack>
    </ActionForm>
  )
}

function BindingForm({ csrf, host, credentials }: { csrf: string, host: SshHostRow, credentials: string[] }) {
  const [username, setUsername] = useState('')
  return (
    <ActionForm action="/v1/admin/ssh/binding" method="POST" csrf={csrf}
      confirmation={{ consequence: 'Replace this account binding? Ordinary and sudo accounts and credentials must differ.' }}>
      {proof}
      <VStack gap={3}>
        <Revision value={host.revision} />
        <input type="hidden" name="host" value={host.id} />
        <Check name="sudo" title="Separate sudo binding" checked={false} />
        <TextInput label="Account username" id={`${host.id}-username`} htmlName="username" value={username} onChange={setUsername} {...{ required: true }} />
        <Field label="Encrypted credential" inputID={`${host.id}-credential`}>
          <select className="select" id={`${host.id}-credential`} name="credential" required>
            <option value="">Select a credential</option>
            {credentials.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </Field>
        <HStack><Button type="submit" label="Save account binding" variant="primary" /></HStack>
      </VStack>
    </ActionForm>
  )
}

function GrantForm({ csrf, host, users }: { csrf: string, host: SshHostRow, users: SshHostsProps['users'] }) {
  return (
    <ActionForm action="/v1/admin/ssh/grant" method="POST" csrf={csrf}
      confirmation={{ consequence: 'Replace this caller’s host grant? Tool and role grants remain required. Clearing access revokes subsequent calls.' }}>
      {proof}
      <VStack gap={3}>
        <Revision value={host.revision} />
        <input type="hidden" name="host" value={host.id} />
        <Field label="Person" inputID={`${host.id}-user`}>
          <select className="select" id={`${host.id}-user`} name="user" required>
            {users.map(user => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select>
        </Field>
        <Check name="shell" title="Allow this person to use the host" checked={false} />
        <Check name="sudo" title="Allow the separate sudo account" checked={false} />
        <HStack><Button type="submit" label="Save caller grant" variant="primary" /></HStack>
      </VStack>
    </ActionForm>
  )
}

function HostPanel({ csrf, host, credentials, users }: { csrf: string, host: SshHostRow } & Pick<SshHostsProps, 'credentials' | 'users'>) {
  return (
    <Panel title={host.id} description={`Revision ${host.revision}`}
      actions={<HStack gap={2}>
        <Badge label={host.enabled ? 'Enabled' : 'Disabled'} variant={host.enabled ? 'success' : 'neutral'} />
        <Badge label={host.readOnly ? 'Read only' : 'Writable'} variant={host.readOnly ? 'neutral' : 'warning'} />
      </HStack>}>
      <VStack gap={4}>
        <details className="all-fields">
          <summary className="btn btn-secondary btn-sm">Edit trust and policy</summary>
          <HostForm csrf={csrf} host={host} />
        </details>
        <VStack gap={2}>
          <Heading level={3}>Account binding</Heading>
          <BindingForm csrf={csrf} host={host} credentials={credentials} />
        </VStack>
        <VStack gap={2}>
          <Heading level={3}>Caller grant</Heading>
          <GrantForm csrf={csrf} host={host} users={users} />
        </VStack>
        <HStack justify="end">
          <ActionForm action="/v1/admin/ssh/host-delete" method="POST" csrf={csrf}
            confirmation={{ consequence: 'Delete this host and remove its bindings and caller grants?', typedName: host.id }}>
            {proof}
            <Revision value={host.revision} />
            <input type="hidden" name="id" value={host.id} />
            <Button type="submit" label="Delete host" variant="ghost" className="danger" icon={<Icon name="trash" />} />
          </ActionForm>
        </HStack>
      </VStack>
    </Panel>
  )
}

export function SshHosts({ csrf, intro, hosts, credentials, users, bindings, grants }: SshHostsProps) {
  return (
    <VStack gap={4}>
      <Text as="p" type="supporting">{intro}</Text>
      {hosts.map(host => <HostPanel key={host.id} csrf={csrf} host={host} credentials={credentials} users={users} />)}
      <Panel title="Register host" description="New hosts start disabled and read only.">
        <HostForm csrf={csrf} />
      </Panel>
      <Panel title="Current bindings and grants" description="Reload after each save to use the current host revision.">
        <VStack gap={4}>
          <VStack gap={2}>
            <Heading level={3}>Account bindings</Heading>
            {bindings.length ? (
              <Table aria-label="Account bindings" scrollWrapper={({ children }) => <div className="table-wrap ssh-events">{children}</div>}>
                <TableHeader>
                  <TableRow isHeaderRow>
                    {['Host', 'Account type', 'Username', 'Credential', 'Revision'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bindings.map(binding => (
                    <TableRow key={`${binding.host}:${binding.sudo}`}>
                      <TableHeaderCell scope="row">{binding.host}</TableHeaderCell>
                      <TableCell data-label="Account type">{binding.sudo ? 'Sudo' : 'Ordinary'}</TableCell>
                      <TableCell data-label="Username"><Mono>{binding.username}</Mono></TableCell>
                      <TableCell data-label="Credential"><Mono>{binding.credential}</Mono></TableCell>
                      <TableCell data-label="Revision">{binding.revision}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <Text as="p" type="supporting">No account bindings.</Text>}
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>Caller grants</Heading>
            {grants.length ? (
              <Table aria-label="Caller grants" scrollWrapper={({ children }) => <div className="table-wrap ssh-events">{children}</div>}>
                <TableHeader>
                  <TableRow isHeaderRow>
                    {['Host', 'Person', 'Host use', 'Sudo account'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.map(grant => (
                    <TableRow key={`${grant.host}:${grant.user}`}>
                      <TableHeaderCell scope="row">{grant.host}</TableHeaderCell>
                      <TableCell data-label="Person">{grant.username ?? <Mono>{grant.user}</Mono>}</TableCell>
                      <TableCell data-label="Host use">{grant.shell ? 'Allowed' : 'Not allowed'}</TableCell>
                      <TableCell data-label="Sudo account">{grant.sudo ? 'Allowed' : 'Not allowed'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <Text as="p" type="supporting">No caller grants.</Text>}
          </VStack>
        </VStack>
      </Panel>
    </VStack>
  )
}
