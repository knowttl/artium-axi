import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { ActionForm } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { Time } from './time.js'

export interface SessionRow { id: string, kind: 'browser' | 'cli', current: boolean, createdAt: string, lastSeenAt: string | null, expiresAt: string }
export interface SessionsProps { csrf: string, path: string, sessions: SessionRow[] }

export function SignOutEverywhere({ csrf, path, sessions, inMenu = false }: SessionsProps & { inMenu?: boolean }) {
  const consequence = `Sign out all ${sessions.length} active browser and CLI sessions now?${sessions.some(session => session.current) ? ' This includes this browser.' : ''}`
  return (
    <ActionForm action={path + '/revoke'} method="POST" csrf={csrf} confirmation={{ consequence, title: 'Sign out everywhere', action: 'Sign out everywhere' }}>
      {inMenu
        ? <Button type="submit" label="Sign out everywhere…" variant="ghost" icon={<Icon name="logout" />} />
        : <Button type="submit" label="Sign out everywhere" variant="secondary" size="sm" />}
    </ActionForm>
  )
}

export function Sessions({ csrf, path, sessions }: SessionsProps) {
  return (
    <Panel title="Sessions" description="Browser sessions and CLI sign-ins. Revoking one ends it now; they can sign in again while their account is enabled."
      actions={sessions.length ? <SignOutEverywhere csrf={csrf} path={path} sessions={sessions} /> : undefined}>
      {sessions.length ? (
        <Table className="session-table" aria-label={`${sessions.length} active sessions`} scrollWrapper={({ children }) => <div className="table-wrap">{children}</div>}>
          <TableHeader>
            <TableRow isHeaderRow>
              {['Session', 'Signed in', 'Last browser activity', 'Expires'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
              <TableHeaderCell scope="col"><VisuallyHidden>Action</VisuallyHidden></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map(session => (
              <TableRow key={session.id}>
                <TableCell>
                  <HStack gap={2} vAlign="center">
                    <Icon name={session.kind === 'browser' ? 'monitor' : 'terminal'} />
                    <VStack gap={0}>
                      <Text type="label">{session.kind === 'browser' ? 'Browser' : 'CLI'}{session.current ? ' (This browser)' : ''}</Text>
                      <Text type="supporting"><code>{session.id}</code></Text>
                    </VStack>
                  </HStack>
                </TableCell>
                <TableCell {...{ 'data-label': 'Signed in' }}><Time iso={session.createdAt} /></TableCell>
                <TableCell {...{ 'data-label': 'Last browser activity' }}><Time iso={session.lastSeenAt} empty="Not tracked for CLI" /></TableCell>
                <TableCell {...{ 'data-label': 'Expires' }}><Time iso={session.expiresAt} /></TableCell>
                <TableCell>
                  <ActionForm action={`${path}/${encodeURIComponent(session.id)}/revoke`} method="POST" csrf={csrf} confirmation={{ title: 'Revoke session', action: 'Revoke',
                    consequence: `Revoke this ${session.kind === 'browser' ? 'browser session' : 'CLI session and all its access and refresh tokens'}?${session.current ? ' This signs you out now.' : ''}` }}>
                    <Button type="submit" label="Revoke" variant="ghost" size="sm" />
                  </ActionForm>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Text as="p" type="supporting">No active sessions. A new session appears when they sign in.</Text>}
    </Panel>
  )
}
