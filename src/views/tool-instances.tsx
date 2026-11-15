import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { LegacyIsland } from './legacy-island.js'
import { Panel } from './panel.js'
import { Sheet } from './sheet.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

interface Row {
  name: string
  description: string
  endpoint: string
  href: string
  status: Status
  writes: Status
  checkedAt: string | null
  instance: { path: string, id: string, revision: number, enabled: boolean, readOnly: boolean, description: string, editOpen: boolean } | null
}

export interface InstancesProps {
  page: string
  ssh: boolean
  testGuide: string | null
  rows: Row[]
  github: { legacyHtml: string } | null
  addInstance: { legacyHtml: string } | null
}

type Editable = Row & { instance: NonNullable<Row['instance']> }

function EditSheet({ csrf, page, row }: { csrf: string, page: string, row: Editable }) {
  const { instance } = row
  const [description, setDescription] = useState(instance.description)
  return (
    <Sheet name={`edit-${row.name}`} open={instance.editOpen} closeHref={page} title={`Edit ${row.name}`}
      description="The name never changes. To rename an instance, add a new one and delete this one."
      submit="Save instance" confirmAction="Save" action={instance.path} method="PATCH" csrf={csrf}
      consequence={`Save the description and read-only setting of ${row.name}? Agents see the new description on their next listing.`}>
      <VStack gap={3}>
        <input type="hidden" name="expectedId" value={instance.id} />
        <Revision value={instance.revision} />
        <TextArea label="Description" htmlName="description" value={description} onChange={setDescription} rows={3} htmlMaxLength={500}
          description="Agents read this to choose between instances. Say what the instance is for." />
        <label className="switch-row">
          <input type="checkbox" className="switch" role="switch" name="readOnly" data-type="boolean" defaultChecked={instance.readOnly} />
          <div><b>Read-only</b><span>Blocks every write through this instance, even when the tool allows writes.</span></div>
        </label>
        <Text as="p" type="supporting">Change the connection and certificates on <a href={row.href}>the instance page</a>.</Text>
      </VStack>
    </Sheet>
  )
}

function Actions({ csrf, page, ssh, row }: { csrf: string, page: string, ssh: boolean, row: Row }) {
  const { instance } = row
  if (!instance) return <Button href={row.href} label={ssh ? 'Manage' : 'Open'} variant="ghost" size="sm" />
  const sheet = `edit-${row.name}`
  const versions = <><input type="hidden" name="expectedId" value={instance.id} /><Revision value={instance.revision} /></>
  return (
    <HStack gap={1} justify="end" vAlign="center">
      <ActionForm action={`${instance.path}/test`} method="POST" csrf={csrf} successMessage="Test passed.">
        <Button type="submit" label="Test" variant="secondary" size="sm" icon={<Icon name="test" />} />
      </ActionForm>
      <Button href={`${page}?sheet=${sheet}`} label="Edit" variant="ghost" size="sm" icon={<Icon name="pen" />} data-sheet={`sheet-${sheet}`} />
      <details className="more-menu">
        <summary className="btn btn-ghost btn-icon btn-sm" aria-label={`More actions for ${row.name}`}><Icon name="more" /></summary>
        <div className="popover">
          <ActionForm action={instance.path} method="PATCH" csrf={csrf} confirmation={instance.enabled
            ? { consequence: `Disable ${row.name}? Calls to it fail with INSTANCE_DISABLED until you enable it again. Its credential and certificates are kept.`, title: 'Disable instance', action: 'Disable' }
            : { consequence: `Enable ${row.name}? Agents who can use it can call it again.`, title: 'Enable instance', action: 'Enable' }}>
            {versions}
            <input type="hidden" name="enabled" data-type="boolean" value={String(!instance.enabled)} />
            <Button type="submit" label={instance.enabled ? 'Disable' : 'Enable'} variant="ghost" />
          </ActionForm>
          <hr />
          <ActionForm action={instance.path} method="DELETE" csrf={csrf}
            confirmation={{ consequence: `Delete ${row.name}? Its credential, certificate trust and health are removed. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.`,
              title: 'Delete instance', action: 'Delete', typedName: row.name }}>
            {versions}
            <Button type="submit" label="Delete…" variant="ghost" className="danger" icon={<Icon name="trash" />} />
          </ActionForm>
        </div>
      </details>
    </HStack>
  )
}

function InstanceTable({ csrf, product, panel }: { csrf: string, product: string, panel: InstancesProps }) {
  const { page, ssh, rows } = panel
  if (!rows.length) return <Text as="p" type="supporting">{ssh ? 'No hosts are registered yet.' : `No instances yet. Add one to connect ${product}.`}</Text>
  return (
    <Table aria-label={`${product} instances`} scrollWrapper={({ children }) => <div className="instances-list">{children}</div>}>
      <TableHeader>
        <TableRow isHeaderRow>
          <TableHeaderCell scope="col">Instance</TableHeaderCell>
          <TableHeaderCell scope="col">Endpoint</TableHeaderCell>
          <TableHeaderCell scope="col">Status</TableHeaderCell>
          <TableHeaderCell scope="col">Writes</TableHeaderCell>
          <TableHeaderCell scope="col">Last checked</TableHeaderCell>
          <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(row => (
          <TableRow key={row.name}>
            <TableHeaderCell scope="row">
              <VStack gap={0}>
                <a href={row.href}>{row.name}</a>
                <Text type="supporting">{row.description || (ssh ? 'SSH host' : 'No description')}</Text>
              </VStack>
            </TableHeaderCell>
            <TableCell data-label="Endpoint"><code>{row.endpoint}</code></TableCell>
            <TableCell data-label="Status"><Badge label={row.status.word} variant={badgeVariants[row.status.tone]} /></TableCell>
            <TableCell data-label="Writes">{row.writes.tone === 'warn' ? <Badge label={row.writes.word} variant="warning" /> : row.writes.word}</TableCell>
            <TableCell data-label="Last checked"><Text type="supporting"><Time iso={row.checkedAt} empty="Never" /></Text></TableCell>
            <TableCell className="actions-cell"><Actions csrf={csrf} page={page} ssh={ssh} row={row} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Notes({ name, ssh, testGuide }: { name: string, ssh: boolean, testGuide: string | null }) {
  if (ssh) {
    return (
      <>
        <Panel title="Dedicated SSH identity">
          <Text as="p">SSH requires separately managed host trust, caller grants and encrypted ordinary account bindings. Generic tenant credentials cannot configure SSH.</Text>
          <Text as="p"><a href="/admin/ssh">Manage hosts, account bindings and grants</a> · <a href="/admin/ssh/credentials">Manage encrypted SSH credentials</a></Text>
        </Panel>
        <Panel title="Check authentication per host">
          <Text as="p">As a caller with a shell grant, run <code>artium-axi ssh-axi host list</code>, then <code>artium-axi ssh-axi doctor &lt;host&gt;</code>. This checks authentication only. There is no shared connection test or cached health result.</Text>
        </Panel>
      </>
    )
  }
  return (
    <>
      <Panel title="What the test does">
        <Text as="p">Runs one harmless read per instance: <code>{testGuide}</code>. It does not enable the tool or grant access.</Text>
      </Panel>
      <Panel title="Choosing an instance">
        <Text as="p">Agents name an instance with <code>{`artium-axi --instance <name> ${name}`}</code>. With one usable instance the flag is optional.</Text>
      </Panel>
    </>
  )
}

export function Instances({ csrf, name, product, panel }: { csrf: string, name: string, product: string, panel: InstancesProps }) {
  const { page, ssh, testGuide, rows, github, addInstance } = panel
  return (
    <VStack gap={4}>
      <Panel title="Instances"
        description={ssh ? 'SSH hosts are reported as instances. Hosts, bindings and grants stay on their own pages.'
          : `Each instance is a named connection to ${product} with its own credential, certificates and read-only setting.`}
        actions={ssh ? <Button href="/admin/ssh" label="Manage hosts" variant="secondary" size="sm" />
          : <Button href={`${page}?sheet=add-instance`} label="Add instance" variant="primary" size="sm" icon={<Icon name="plus" />} data-sheet="sheet-add-instance" />}>
        <InstanceTable csrf={csrf} product={product} panel={panel} />
      </Panel>
      {github && <LegacyIsland {...github} />}
      <Notes name={name} ssh={ssh} testGuide={testGuide} />
      {rows.map(row => row.instance && <EditSheet key={row.name} csrf={csrf} page={page} row={{ ...row, instance: row.instance }} />)}
      {addInstance && <LegacyIsland {...addInstance} />}
    </VStack>
  )
}
