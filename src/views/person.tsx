import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { List, ListItem } from '@astryxdesign/core/List'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { VStack } from '@astryxdesign/core/VStack'
import { useState, type ReactNode } from 'react'
import { ActionForm, ActionSubmit, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { temporaryPasswordHint } from './people.js'
import { RoleOptions, type RoleOption } from './role-options.js'
import { Sessions, SignOutEverywhere, type SessionsProps } from './sessions.js'
import { Sheet, sheetTrigger } from './sheet.js'
import { badgeVariants, type Status } from './status.js'
import { LastChange, Time } from './time.js'

interface Link { href: string, label: string }

export interface PersonProps {
  identity: { initials: string, username: string, signIn: Status, state: Status, administrator: boolean }
  changed: { actor: string, at: string | null, revision: number }
  ruleGrants: { role: string, provider: string, rule: string }[]
  archived: { at: string, roles: Link[] } | null
  active: {
    csrf: string
    path: string
    revision: number
    displayName: string
    administrator: boolean
    enabled: boolean
    linkToSso: string | null
    menu: { auditHref: string, breakGlass: { designated: boolean } | null }
    roles: RoleOption[]
    directRoleIds: string[]
    tools: { name: string, product: string, mark: string, access: Status, failing: boolean, grantedBy: Link[] }[]
    sessions: SessionsProps
    facts: { method: string, failedAttempts: number, lockedUntil: string | null, password: string | null }
    reset: { open: boolean, closeHref: string } | null
  } | null
}

type Active = NonNullable<PersonProps['active']>

function Chips({ links }: { links: Link[] }) {
  return <HStack gap={1} wrap="wrap">{links.map(link => <Token key={link.href + link.label} className="row-chip" href={link.href} label={link.label} />)}</HStack>
}

function RuleGrants({ grants }: { grants: PersonProps['ruleGrants'] }) {
  return grants.length ? (
    <List>
      {grants.map(grant => (
        <ListItem key={grant.rule} startContent={<Badge label="SSO rule" variant="info" />} label={grant.role}
          description={<>{`From ${grant.provider} rule `}<code>{grant.rule}</code></>} />
      ))}
    </List>
  ) : null
}

function Row({ title, text, children }: { title: string, text: string, children: ReactNode }) {
  return (
    <HStack gap={3} justify="between" vAlign="center">
      <VStack gap={0.5}><Text type="label">{title}</Text><Text type="supporting">{text}</Text></VStack>
      {children}
    </HStack>
  )
}

function Roles({ active, ruleGrants, username }: { active: Active, ruleGrants: PersonProps['ruleGrants'], username: string }) {
  return (
    <Panel title="Roles" description="Direct roles are set here. Roles from SSO rules sync at each sign-in.">
      <ActionForm action={active.path + '/roles'} method="PUT" csrf={active.csrf}
        confirmation={{ consequence: `Replace ${username}’s direct roles with this selection? Tool access changes on the next call.`, title: 'Save roles', action: 'Save roles' }}>
        <VStack gap={3}>
          <RoleOptions legend="Direct roles" roles={active.roles} selected={active.directRoleIds} />
          <RuleGrants grants={ruleGrants} />
          <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
            <Text type="supporting">Saving replaces direct roles and keeps rule grants. Changes apply on their next tool call.</Text>
            <Revision value={active.revision} />
            <ActionSubmit label="Save roles" variant="primary" size="sm" />
          </HStack>
        </VStack>
      </ActionForm>
    </Panel>
  )
}

function Tools({ tools }: { tools: Active['tools'] }) {
  return (
    <Panel title="What can they use?" description="All tools from all their roles. A disabled person or tool cannot run calls.">
      {tools.length ? (
        <Table aria-label="Tools they can use" scrollWrapper={({ children }) => <div className="table-wrap">{children}</div>}>
          <TableHeader>
            <TableRow isHeaderRow>{['Tool', 'Can run calls', 'Granted by'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}</TableRow>
          </TableHeader>
          <TableBody>
            {tools.map(tool => (
              <TableRow key={tool.name}>
                <TableCell>
                  <HStack gap={2} vAlign="center">
                    <span className="tool-ico" aria-hidden="true">{tool.mark}</span>
                    <VStack gap={0}><Text type="label">{tool.product}</Text><Text type="supporting">{tool.name}</Text></VStack>
                  </HStack>
                </TableCell>
                <TableCell>
                  <HStack gap={1} wrap="wrap" vAlign="center">
                    <Badge label={tool.access.word} variant={badgeVariants[tool.access.tone]} />
                    {tool.failing && <Text type="supporting">(currently failing)</Text>}
                  </HStack>
                </TableCell>
                <TableCell><Chips links={tool.grantedBy} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Text as="p" type="supporting">No tools granted. Assign a role that grants tools.</Text>}
    </Panel>
  )
}

function Danger({ active, username }: { active: Active, username: string }) {
  const { csrf, path, revision, enabled } = active
  return (
    <Panel title="Danger zone">
      <VStack gap={3}>
        <Row title={enabled ? 'Disable access' : 'Enable access'}
          text={enabled ? 'Blocks sign-in and ends all their sessions now. You can enable them again later.' : 'Lets them sign in again. Revoked sessions stay signed out.'}>
          <ActionForm action={path} method="PATCH" csrf={csrf} confirmation={enabled
            ? { consequence: `Disable ${username}? Sign-in is blocked and all their browser and CLI sessions are revoked immediately.`, title: 'Disable access', action: 'Disable' }
            : { consequence: `Enable ${username}? They can sign in again; revoked sessions stay signed out.`, title: 'Enable access', action: 'Enable' }}>
            <Revision value={revision} />
            <input type="hidden" name="enabled" data-type="boolean" value={String(!enabled)} />
            <ActionSubmit label={enabled ? 'Disable…' : 'Enable…'} variant={enabled ? 'destructive' : 'secondary'} size="sm" />
          </ActionForm>
        </Row>
        <Row title="Archive person" text="Permanent. Hides them from People, blocks sign-in and revokes all sessions. History and role membership are kept.">
          <ActionForm action={path + '/archive'} method="POST" csrf={csrf} successUrl="/admin/users"
            confirmation={{ title: 'Archive person', action: 'Archive', typedName: username,
              consequence: `Archive ${username}? All browser and CLI sessions are revoked, sign-in is blocked, and history is retained. This cannot be undone here.` }}>
            <Revision value={revision} />
            <ActionSubmit label="Archive…" variant="destructive" size="sm" />
          </ActionForm>
        </Row>
      </VStack>
    </Panel>
  )
}

function Profile({ active, username }: { active: Active, username: string }) {
  const [displayName, setDisplayName] = useState(active.displayName)
  return (
    <Panel title="Profile">
      <ActionForm action={active.path} method="PATCH" csrf={active.csrf}
        confirmation={{ consequence: `Update ${username}’s profile and administrator capability? Administrator access changes immediately.`, title: 'Save profile', action: 'Save profile' }}>
        <VStack gap={3}>
          <Revision value={active.revision} />
          <TextInput label="Display name" htmlName="displayName" value={displayName} onChange={setDisplayName} {...{ required: true }} />
          <label className="check">
            <input type="checkbox" name="administrator" data-type="boolean" defaultChecked={active.administrator} />
            <span><strong>Administrator</strong><span>Manage people, roles, tools and sign-in. Changes immediately.</span></span>
          </label>
          <div><ActionSubmit label="Save profile" variant="secondary" size="sm" /></div>
        </VStack>
      </ActionForm>
    </Panel>
  )
}

function SignIn({ active, username }: { active: Active, username: string }) {
  const { method, failedAttempts, lockedUntil, password } = active.facts
  return (
    <Panel title="Sign-in">
      <VStack gap={3}>
        <dl className="kv">
          <dt>Method</dt><dd>{method}</dd>
          <dt>Failed sign-ins</dt><dd>{failedAttempts}</dd>
          <dt>Locked</dt><dd>{lockedUntil === null ? 'No' : <>Until <Time iso={lockedUntil} /></>}</dd>
          {password !== null && <><dt>Password</dt><dd>{password}</dd></>}
        </dl>
        {lockedUntil !== null && (
          <ActionForm action={active.path + '/unlock'} method="POST" csrf={active.csrf}
            confirmation={{ consequence: `Clear ${username}’s failed sign-in attempts and lockout? Their password and sessions stay unchanged.`, title: 'Unlock', action: 'Unlock' }}>
            <ActionSubmit label="Unlock" variant="secondary" size="sm" icon={<Icon name="unlock" />} />
          </ActionForm>
        )}
      </VStack>
    </Panel>
  )
}

function ResetPassword({ active, username, reset }: { active: Active, username: string, reset: NonNullable<Active['reset']> }) {
  const [password, setPassword] = useState('')
  return (
    <Sheet name="reset-password" open={reset.open} closeHref={reset.closeHref} title="Reset password" description={`Set a new temporary password for ${username}.`} submit="Reset password"
      action={active.path + '/password-reset'} csrf={active.csrf}
      consequence={`Reset ${username}’s password? All their sessions are revoked and they must change the temporary password on next sign-in.`}>
      <TextInput label="Temporary password" htmlName="temporaryPassword" type="password" value={password} onChange={setPassword} description={temporaryPasswordHint}
        autoComplete="new-password" {...{ required: true }} />
      <Banner status="warning" icon={<Icon name="alert" />} title="All their sessions end"
        description="They are signed out everywhere and must change the temporary password at their next sign-in." />
    </Sheet>
  )
}

function MoreActions({ active, username }: { active: Active, username: string }) {
  const { menu, reset, sessions } = active
  const designated = menu.breakGlass?.designated
  return (
    <details className="more-menu">
      <summary className="btn btn-secondary btn-icon" aria-label="More actions"><Icon name="more" /></summary>
      <div className="popover">
        {reset && <Button href={reset.closeHref + '?sheet=reset-password'} label="Reset password…" variant="ghost" icon={<Icon name="key" />} {...sheetTrigger('sheet-reset-password')} />}
        {sessions.sessions.length > 0 && <SignOutEverywhere {...sessions} inMenu />}
        {menu.breakGlass && (
          <ActionForm action={active.path} method="PATCH" csrf={active.csrf} confirmation={designated
            ? { consequence: `Remove ${username}’s break-glass designation and revoke all their sessions?`, title: 'Remove break-glass designation', action: 'Remove designation' }
            : { consequence: `Designate ${username} for emergency local password access when SSO is enabled? Reserve this for emergency access; every use is flagged in the audit log.`,
              title: 'Make break-glass admin', action: 'Designate' }}>
            <Revision value={active.revision} />
            <input type="hidden" name="breakGlass" data-type="boolean" value={String(!designated)} />
            <ActionSubmit label={designated ? 'Remove break-glass designation…' : 'Make break-glass admin…'} variant="ghost" icon={<Icon name="shield" />} />
          </ActionForm>
        )}
        <hr />
        <Button href={menu.auditHref} label="View in audit log" variant="ghost" icon={<Icon name="list" />} />
      </div>
    </details>
  )
}

export function Person({ identity, changed, ruleGrants, archived, active }: PersonProps) {
  const { username } = identity
  return (
    <VStack gap={4}>
      <HStack className="person-identity" gap={3} justify="between" vAlign="center" wrap="wrap">
        <HStack gap={3} vAlign="center" wrap="wrap">
          <span className="avatar lg" aria-hidden="true">{identity.initials}</span>
          <code>{username}</code>
          <Badge label={identity.signIn.word} variant={badgeVariants[identity.signIn.tone]} />
          <Badge label={identity.state.word} variant={badgeVariants[identity.state.tone]} />
          {identity.administrator && <Badge label="Admin" variant="neutral" />}
        </HStack>
        {active && (
          <HStack gap={2} vAlign="center">
            {active.linkToSso && <Button href={active.linkToSso} label="Link to SSO" variant="secondary" icon={<Icon name="link" />} />}
            <MoreActions active={active} username={username} />
          </HStack>
        )}
      </HStack>
      {archived && (
        <Banner status="info" icon={<Icon name="info" />} title="Archived person"
          description={<>Archived at <Time iso={archived.at} />. Sign-in is blocked, all sessions are revoked, and history is retained. This page is read-only.</>} />
      )}
      <div className="grid2">
        {active ? (
          <VStack gap={4}>
            <Roles active={active} ruleGrants={ruleGrants} username={username} />
            <Tools tools={active.tools} />
            <Sessions {...active.sessions} />
            <Danger active={active} username={username} />
          </VStack>
        ) : archived && (
          <VStack gap={4}>
            <Panel title="Roles" description="Membership is retained. This account stays archived.">
              {archived.roles.length ? <Chips links={archived.roles} /> : <Text as="p" type="supporting">No retained roles remain.</Text>}
              <RuleGrants grants={ruleGrants} />
            </Panel>
          </VStack>
        )}
        <VStack gap={4}>
          {active && <><Profile active={active} username={username} /><SignIn active={active} username={username} /></>}
          <LastChange {...changed} />
        </VStack>
      </div>
      {active?.reset && <ResetPassword active={active} username={username} reset={active.reset} />}
    </VStack>
  )
}
