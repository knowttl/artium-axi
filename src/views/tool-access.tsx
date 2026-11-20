import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Field } from '@astryxdesign/core/Field'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { Sheet, sheetTrigger } from './sheet.js'

interface Person { id: string, username: string, displayName: string }
interface Operation { id: string, label: string }

export interface AccessProps {
  page: string
  sheet: string | null
  people: Person[]
  roles: { id: string, name: string, members: number, all: boolean, revision: number, instances: { name: string, description: string, checked: boolean }[] }[]
  policies: { key: string, title: string, description: string, creatable: boolean, operations: Operation[],
    grants: { id: string, summary: string, operations: (Operation & { checked: boolean })[] }[] }[]
}

type Policy = AccessProps['policies'][number]

interface Context { csrf: string, api: string, name: string, product: string, revision: number, access: AccessProps }

const opensSheet = (access: AccessProps, name: string) => ({ href: `${access.page}&sheet=${encodeURIComponent(name)}`, ...sheetTrigger(`sheet-${name}`) })

function Checkbox({ name, value, title, description, checked }: { name: string, value: string, title: string, description?: string, checked: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} />
      <span><strong>{title}</strong>{description && <span>{description}</span>}</span>
    </label>
  )
}

function RoleSheet({ csrf, name, product, access, role }: Context & { role: AccessProps['roles'][number] }) {
  const sheet = `instances-${role.id}`
  return (
    <Sheet name={sheet} open={access.sheet === sheet} closeHref={access.page} title={`Instance access for ${role.name}`}
      description={`Choose which ${product} instances members of this role can use.`} submit="Save access" confirmTitle="Save instance access"
      action={`/v1/admin/roles/${encodeURIComponent(role.id)}/tools/${name}/instances`} method="PUT" csrf={csrf}
      consequence={`Replace ${role.name}’s ${product} instance access? Changes apply to every member on the next call.`}>
      <VStack gap={3}>
        <fieldset className="options">
          <legend className="sr-only">Instance access</legend>
          <label className="option">
            <input type="radio" name="scope" value="all" defaultChecked={role.all} />
            <div><strong>All instances</strong><span>Includes instances added later.</span></div>
          </label>
          <label className="option">
            <input type="radio" name="scope" value="selected" defaultChecked={!role.all} />
            <div><strong>Selected instances</strong><span>Only the instances checked below. Any other instance reports that it does not exist.</span></div>
          </label>
        </fieldset>
        <fieldset className="options">
          <legend>Instances</legend>
          <input type="hidden" name="instances" disabled data-type="array" />
          {role.instances.map(instance => <Checkbox key={instance.name} name="instances" value={instance.name} title={instance.name} description={instance.description} checked={instance.checked} />)}
        </fieldset>
        <Revision value={role.revision} />
      </VStack>
    </Sheet>
  )
}

function Roles({ name, product, access }: Context) {
  return (
    <Panel title={`Roles that grant ${product}`} description="Enabling alone gives nobody access. Assign these roles to people on People."
      actions={<Button href="/admin/roles" label="Manage roles" variant="secondary" size="sm" />}>
      {access.roles.length ? (
        <List hasDividers>
          {access.roles.map(role => {
            const selected = role.instances.filter(instance => instance.checked).map(instance => instance.name)
            return (
              <ListItem key={role.id} startContent={<Icon name="shield" />} label={<a href={`/admin/roles/${role.id}`}>{role.name}</a>}
                description={`${role.members} ${role.members === 1 ? 'person' : 'people'} · ${role.all ? 'All instances' : `Selected instances: ${selected.join(', ') || 'None'}`}`}
                endContent={<Button label="Instances" variant="ghost" size="sm" {...opensSheet(access, `instances-${role.id}`)} />} />
            )
          })}
        </List>
      ) : <Text as="p" type="supporting">No roles grant this tool. Open a role and select this tool to give its members access.</Text>}
    </Panel>
  )
}

function GrantSheet({ csrf, api, product, revision, access, policy, suffix, title, userId, operations }:
  Context & { policy: Policy, suffix: string, title: string, userId: string | null, operations: (Operation & { checked: boolean })[] }) {
  const granted = new Set(policy.grants.map(grant => grant.id))
  const sheet = `grants-${policy.key}-${suffix}`
  return (
    <Sheet name={sheet} open={access.sheet === sheet} closeHref={access.page} title={title} description={policy.description} submit="Save grants"
      action={`${api}/user-grants`} method="PUT" csrf={csrf}
      consequence={`Replace this person’s ${policy.title.toLowerCase()} grants for ${product}? Clearing every operation removes the person. The change applies on their next call and is audited.`}>
      <VStack gap={3}>
        {userId === null
          ? (
            <Field label="Person" inputID={`${sheet}-user`}>
              <select className="select" id={`${sheet}-user`} name="userId" required>
                {access.people.filter(candidate => !granted.has(candidate.id)).map(candidate =>
                  <option key={candidate.id} value={candidate.id}>{candidate.username}{candidate.displayName === candidate.username ? '' : ` (${candidate.displayName})`}</option>)}
              </select>
            </Field>
          )
          : <input type="hidden" name="userId" value={userId} />}
        <fieldset className="options">
          <legend>Operations</legend>
          <input type="hidden" name="operations" disabled data-type="array" />
          {operations.map((operation, index) => <Checkbox key={index} name="operations" value={operation.id} title={operation.label} description={operation.id} checked={operation.checked} />)}
        </fieldset>
        <input type="hidden" name="policy" value={policy.key} />
        <Revision value={revision} />
      </VStack>
    </Sheet>
  )
}

function Grants(context: Context & { policy: Policy }) {
  const { access, policy } = context
  const granted = new Set(policy.grants.map(grant => grant.id))
  const canAdd = policy.creatable && access.people.some(person => !granted.has(person.id))
  const addName = `grants-${policy.key}-add`
  return (
    <>
      <Panel title={`${policy.title} by person`} description={policy.description}
        actions={canAdd ? <Button label="Grant a person" variant="secondary" size="sm" {...opensSheet(access, addName)} /> : undefined}>
        {policy.grants.length ? (
          <List hasDividers>
            {policy.grants.map(grant => {
              const person = access.people.find(candidate => candidate.id === grant.id)
              return (
                <ListItem key={grant.id} startContent={<Icon name="users" />}
                  label={<><strong>{person?.username ?? grant.id}</strong>{!person && <> <Badge label="Not an active person" variant="warning" /></>}</>}
                  description={grant.summary} endContent={<Button label="Edit" variant="ghost" size="sm" {...opensSheet(access, `grants-${policy.key}-${grant.id}`)} />} />
              )
            })}
          </List>
        ) : <Text as="p" type="supporting">No one is granted. Nobody can use this until you grant a person.</Text>}
        {!policy.creatable && <Text as="p" type="supporting">Set the ceilings for this policy in Advanced native settings before granting people here.</Text>}
      </Panel>
      {policy.grants.map(grant => <GrantSheet key={grant.id} {...context} suffix={grant.id} title={`${policy.title} for ${access.people.find(person => person.id === grant.id)?.username ?? grant.id}`}
        userId={grant.id} operations={grant.operations} />)}
      {canAdd && <GrantSheet {...context} suffix="add" title={`Grant ${policy.title.toLowerCase()}`} userId={null} operations={policy.operations.map(operation => ({ ...operation, checked: false }))} />}
    </>
  )
}

export function Access(context: Omit<Context, 'access'> & { panel: AccessProps }) {
  const full = { ...context, access: context.panel }
  return (
    <VStack gap={4}>
      <Roles {...full} />
      {full.access.roles.map(role => <RoleSheet key={role.id} {...full} role={role} />)}
      {full.access.policies.map(policy => <Grants key={policy.key} {...full} policy={policy} />)}
    </VStack>
  )
}
