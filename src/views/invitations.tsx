import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Token } from '@astryxdesign/core/Token'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { RoleOptions, type RoleOption } from './role-options.js'
import { Sheet } from './sheet.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

const defaultLifetimeDays = '7'

export interface InvitationsProps {
  csrf: string
  path: string
  banner: { status: 'info' | 'warning', title: string, text: string, link: { href: string, label: string } } | null
  invitations: { id: string, name: string, initials: string, detail: string, username: string, provider: string, roles: string[], status: Status, expiresAt: string,
    actions: { resend: { open: boolean, closeHref: string, href: string }, revision: number } | null }[]
  pager: { summary: string, first: string | null, next: string | null }
  create: { open: boolean, closeHref: string, title: string, description: string, providers: { id: string, name: string, enabled: boolean }[], roles: RoleOption[],
    userId: string | null, displayName: string } | null
}

function Lifetime() {
  const [days, setDays] = useState(defaultLifetimeDays)
  return <TextInput label="Expires in" htmlName="expiresInDays" value={days} onChange={setDays} inputMode="numeric" description="Choose 1 to 30 days." width={160}
    {...{ required: true, min: 1, max: 30, 'data-type': 'number' }} />
}

function NewInvitationSheet({ csrf, path, create }: { csrf: string, path: string, create: NonNullable<InvitationsProps['create']> }) {
  const [fields, setFields] = useState({ displayName: create.displayName, expectedUsername: '' })
  return (
    <Sheet name="new-invitation" open={create.open} closeHref={create.closeHref} title={create.title} description={create.description} submit="Create invitation"
      action={path} csrf={csrf} claimLink confirmAction="Create link"
      consequence="Create a one-time invitation link? It is shown once; copy it before closing the result and send it securely yourself.">
      <Field label="Provider" inputID="invite-provider">
        <select className="select" id="invite-provider" name="providerId" required>
          {create.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.enabled ? '' : ' (not enabled yet)'}</option>)}
        </select>
      </Field>
      {create.userId && <input type="hidden" name="userId" value={create.userId} />}
      <TextInput label="Display name" htmlName="displayName" value={fields.displayName} onChange={displayName => setFields({ ...fields, displayName })}
        {...{ required: true, maxLength: 256 }} />
      <TextInput label="Expected username" htmlName="expectedUsername" value={fields.expectedUsername} onChange={expectedUsername => setFields({ ...fields, expectedUsername })}
        description="The exact preferred_username claim the provider sends: the Entra ID sign-in name, or the OpenID Connect username. It must match when the link is claimed. Accounts are never linked by email."
        autoComplete="off" hasSpellCheck={false} controlClassName="mono" {...{ required: true, maxLength: 256 }} />
      <RoleOptions legend="Roles to add when claimed" roles={create.roles} selected={[]} />
      <Lifetime />
    </Sheet>
  )
}

function ResendSheet({ csrf, path, invitation }: { csrf: string, path: string, invitation: InvitationsProps['invitations'][number] }) {
  const { id, name, actions } = invitation
  return (
    <Sheet name={`resend-${id}`} open={actions!.resend.open} closeHref={actions!.resend.closeHref} title="Resend invitation"
      description={`A new link for ${name}. The old link stops working immediately.`} submit="Resend invitation" action={`${path}/${encodeURIComponent(id)}/resend`} csrf={csrf}
      claimLink confirmAction="Resend" consequence="Replace this invitation link? The old link immediately stops working. Send the new link securely yourself.">
      <Revision value={actions!.revision} />
      <Lifetime />
    </Sheet>
  )
}

function ClaimLinkDialog() {
  return (
    <dialog id="invitation-link" className="modal" aria-labelledby="invitation-link-title">
      <div className="modal-body">
        <Heading level={2} id="invitation-link-title"><span className="ico-circle ok"><Icon name="link" /></span>Copy the invitation link now</Heading>
        <p>This link is shown once. Send it to the person over a channel you trust. Their provider must be enabled before they can claim it.</p>
        <div className="copy-group">
          <div className="copyfield">
            <input className="input" data-claim-link="" readOnly aria-label="Invitation link" />
            <Button type="button" label="Copy" variant="primary" icon={<Icon name="copy" />} data-copy="" />
          </div>
          <p className="copy-status" data-copy-status="" role="status" />
        </div>
      </div>
      <form method="dialog" className="modal-foot"><Button type="submit" label="Done" variant="secondary" /></form>
    </dialog>
  )
}

export function Invitations({ csrf, path, banner, invitations, pager, create }: InvitationsProps) {
  return (
    <VStack gap={4}>
      {banner && (
        <Banner status={banner.status} role="status" icon={<Icon name={banner.status === 'info' ? 'info' : 'alert'} />} title={banner.title} description={banner.text}
          endContent={<Button href={banner.link.href} label={banner.link.label} variant="secondary" size="sm" />} />
      )}
      {invitations.length ? (
        <Card padding={0}>
          <VisuallyHidden as="h2">Invitations</VisuallyHidden>
          <Table aria-label="Invitations" scrollWrapper={({ children }) => <div className="table-wrap invitations-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Person', 'Expected username', 'Provider', 'Roles on claim', 'Status', 'Expires'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map(invitation => (
                <TableRow key={invitation.id} {...{ 'data-invitation': invitation.id }}>
                  <TableCell>
                    <HStack gap={2} vAlign="center">
                      <span className="avatar" aria-hidden="true">{invitation.initials}</span>
                      <VStack gap={0}>
                        <Text type="label">{invitation.name}</Text>
                        <Text type="supporting">{invitation.detail}</Text>
                      </VStack>
                    </HStack>
                  </TableCell>
                  <TableCell><code>{invitation.username}</code></TableCell>
                  <TableCell><Text type="supporting">{invitation.provider}</Text></TableCell>
                  <TableCell>
                    {invitation.roles.length
                      ? <HStack gap={1} wrap="wrap">{invitation.roles.map(role => <Token key={role} label={role} />)}</HStack>
                      : <Text type="supporting">None</Text>}
                  </TableCell>
                  <TableCell><Badge label={invitation.status.word} variant={badgeVariants[invitation.status.tone]} /></TableCell>
                  <TableCell><Text type="supporting"><Time iso={invitation.expiresAt} /></Text></TableCell>
                  <TableCell>
                    {invitation.actions && (
                      <HStack gap={1} vAlign="center">
                        <Button href={invitation.actions.resend.href} label="Resend" variant="ghost" size="sm" data-sheet={`sheet-resend-${invitation.id}`} />
                        <ActionForm action={`${path}/${encodeURIComponent(invitation.id)}/revoke`} method="POST" csrf={csrf}
                          confirmation={{ consequence: 'Revoke this invitation? The link can no longer be claimed. Existing accounts and access are unchanged.', title: 'Revoke invitation', action: 'Revoke' }}>
                          <Revision value={invitation.actions.revision} />
                          <Button type="submit" label="Revoke" variant="ghost" size="sm" />
                        </ActionForm>
                      </HStack>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <HStack className="card-foot" gap={3} justify="between" vAlign="center">
            <Text type="supporting">{pager.summary}</Text>
            <nav aria-label="Pages">
              <HStack gap={2}>
                <Button href={pager.first ?? undefined} isDisabled={!pager.first} label="First page" variant="secondary" size="sm" />
                <Button href={pager.next ?? undefined} isDisabled={!pager.next} label="Next" variant="secondary" size="sm" />
              </HStack>
            </nav>
          </HStack>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No invitations yet" headingLevel={2}
            description="Create an invitation to let someone sign in with SSO for the first time. To keep a local account’s history, open that person and choose Link to SSO." />
        </Card>
      )}
      {create && <NewInvitationSheet csrf={csrf} path={path} create={create} />}
      {invitations.filter(invitation => invitation.actions).map(invitation => <ResendSheet key={invitation.id} csrf={csrf} path={path} invitation={invitation} />)}
      <ClaimLinkDialog />
    </VStack>
  )
}
