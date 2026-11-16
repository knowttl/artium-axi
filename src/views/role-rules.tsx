import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { Sheet } from './sheet.js'
import { LastChange } from './time.js'

export interface RuleSheet {
  id: string | null
  claim: string
  value: string
  roleId: string
  revision: number
  changed: { actor: string, at: string | null, revision: number } | null
}

export interface RoleRulesProps {
  providerId: string
  kind: 'entra' | 'oidc'
  roles: { id: string, name: string }[]
  rules: { id: string, claim: string, value: string, roleId: string, roleName: string, tools: string[], matches: number, revision: number }[]
  addOpen: boolean
  edit: RuleSheet | null
}

const rulesPath = '/v1/admin/sso/role-rules'

function RuleForm({ providerId, kind, roles, rule, prefix }: Pick<RoleRulesProps, 'providerId' | 'kind' | 'roles'> & { rule: RuleSheet, prefix: string }) {
  const [claim, setClaim] = useState(rule.claim)
  const [value, setValue] = useState(rule.value)
  return (
    <VStack gap={3}>
      {rule.id && <Revision value={rule.revision} />}
      <input type="hidden" name="providerId" value={providerId} />
      {rule.changed && <LastChange {...rule.changed} />}
      {kind === 'entra'
        ? <><input type="hidden" name="claim" value="roles" /><Text as="p" type="supporting">Claim: <code>roles</code> (Entra app roles)</Text></>
        : <TextInput label="Claim name" id={`${prefix}-claim`} htmlName="claim" value={claim} onChange={setClaim} controlClassName="mono" autoComplete="off" hasSpellCheck={false}
          description="An exact top-level claim name, for example groups. Dots are literal, not nested paths. String values and strings in arrays match exactly; other values are ignored."
          {...{ required: true, maxLength: 256 }} />}
      <TextInput label="Claim value" id={`${prefix}-value`} htmlName="value" value={value} onChange={setValue} controlClassName="mono" autoComplete="off" hasSpellCheck={false}
        description={kind === 'entra' ? 'The app role value, for example Artium.Readers, rather than its display name.' : 'The exact, case-sensitive value, for example Readers.'}
        {...{ required: true, maxLength: 256 }} />
      <Field label="Artium role" inputID={`${prefix}-role`} descriptionID={`${prefix}-role-hint`} description="Tool access comes from this role. Rules never grant administrator capability.">
        <select id={`${prefix}-role`} name="roleId" className="select" aria-describedby={`${prefix}-role-hint`} required defaultValue={rule.roleId}>
          <option value="">Choose a role</option>
          {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </Field>
    </VStack>
  )
}

function RuleActions({ csrf, page, rule }: { csrf: string, page: string, rule: RoleRulesProps['rules'][number] }) {
  return (
    <details className="more-menu">
      <summary className="btn btn-ghost btn-icon btn-sm" aria-label="Rule actions"><Icon name="more" /></summary>
      <div className="popover">
        <Button href={`${page}?tab=rules&rule=${encodeURIComponent(rule.id)}`} label="Edit rule" variant="ghost" icon={<Icon name="pen" />} />
        <hr />
        <ActionForm action={`${rulesPath}/${rule.id}`} method="DELETE" csrf={csrf} confirmation={{ typedName: rule.value,
          consequence: 'Remove this mapping and immediately remove its rule-origin grants? Direct grants and grants from other rules are retained. This cannot be undone.' }}>
          <Revision value={rule.revision} />
          <Button type="submit" label="Remove rule" variant="ghost" className="danger" icon={<Icon name="trash" />} />
        </ActionForm>
      </div>
    </details>
  )
}

function RulesTable({ csrf, page, rules }: { csrf: string, page: string, rules: RoleRulesProps['rules'] }) {
  return (
    <Table aria-label="Role rules" scrollWrapper={({ children }) => <div className="rules-list">{children}</div>}>
      <TableHeader>
        <TableRow isHeaderRow>
          <TableHeaderCell scope="col">Rule</TableHeaderCell>
          <TableHeaderCell scope="col">Grants</TableHeaderCell>
          <TableHeaderCell scope="col">People</TableHeaderCell>
          <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map(rule => (
          <TableRow key={rule.id} {...{ 'data-rule': rule.id }}>
            <TableHeaderCell scope="row"><code>{rule.claim}</code> contains <code>{rule.value}</code></TableHeaderCell>
            <TableCell className="rule-grants">
              <VStack gap={0.5}>
                <a href={`/admin/roles/${rule.roleId}`}>{rule.roleName}</a>
                <Text type="supporting">{rule.tools.join(', ') || 'No tools granted'} · synced at each sign-in</Text>
              </VStack>
            </TableCell>
            <TableCell>
              <a className="link" href={`${page}/matches/${encodeURIComponent(rule.id)}`} data-who-matches="">{`${rule.matches} ${rule.matches === 1 ? 'match' : 'matches'}`}</a>
            </TableCell>
            <TableCell className="actions-cell"><HStack justify="end"><RuleActions csrf={csrf} page={page} rule={rule} /></HStack></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RoleRules({ csrf, page, rules: { providerId, kind, roles, rules, addOpen, edit } }: { csrf: string, page: string, rules: RoleRulesProps }) {
  const back = `${page}?tab=rules`
  const form = { providerId, kind, roles }
  return (
    <VStack gap={4}>
      <Panel title="Role rules" description={kind === 'entra' ? 'Map an exact, case-sensitive value in the Entra roles claim to an Artium role.' : 'Map an exact, case-sensitive value in any named claim to an Artium role.'}
        actions={roles.length ? <Button href={`${back}&rule=new`} label="Add rule" variant="secondary" size="sm" icon={<Icon name="plus" />} data-sheet="sheet-add-rule" /> : undefined}>
        {rules.length
          ? <RulesTable csrf={csrf} page={page} rules={rules} />
          : <EmptyState title="No role rules yet" headingLevel={3}
            description={roles.length ? 'Add a mapping after granting the role its tools.' : 'Create an Artium role on the Roles page before adding rules.'}
            actions={roles.length ? undefined : <Button href="/admin/roles" label="Create an Artium role" variant="secondary" size="sm" />} />}
        <Text as="p" type="supporting">Rules synchronize at sign-in. Removing or retargeting a rule immediately removes its grants; direct and other-rule grants remain. Match counts use enabled people’s last successful sign-in claims, not a live directory.</Text>
      </Panel>
      {roles.length > 0 && (
        <Sheet name="add-rule" open={addOpen} query="rule" closeHref={back} title="Add rule" description="Matching people receive the role at their next sign-in." submit="Add rule"
          confirmTitle="Add rule?" action={rulesPath} csrf={csrf} consequence="Add this mapping? Matching users receive its role at their next sign-in." successUrl={back}>
          <RuleForm {...form} prefix="add-rule" rule={{ id: null, claim: 'groups', value: '', roleId: '', revision: 0, changed: null }} />
        </Sheet>
      )}
      {edit && (
        <Sheet key={edit.id} name="edit-rule" open query="rule" closeHref={back} title="Edit rule" description="Changes apply at each person’s next sign-in." submit="Save rule"
          confirmTitle="Save rule?" action={`${rulesPath}/${edit.id}`} method="PATCH" csrf={csrf} successUrl={back}
          consequence="Save this mapping? Changing its claim name, value or target role immediately removes its existing rule-origin grants. Direct grants and grants from other rules are retained. Matching users receive grants at their next sign-in.">
          <RuleForm {...form} prefix="edit-rule" rule={edit} />
        </Sheet>
      )}
    </VStack>
  )
}
