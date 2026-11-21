import { Badge } from '@astryxdesign/core/Badge'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { ActionForm, ActionSubmit } from './action-form.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface TokensProps {
  csrf: string
  settings: { mintingEnabled: boolean, maxLifetimeHours: number, ssoWindowDays: number }
  tokens: { id: string, label: string, creator: string, writable: boolean, singleUse: boolean, expiresAt: string, status: Status, revocable: boolean,
    scope: { tool: string, instances?: string[], commands?: string[] }[] }[]
}

function Settings({ csrf, settings }: Pick<TokensProps, 'csrf' | 'settings'>) {
  return (
    <Panel title="Settings" description="Control new token creation.">
      <ActionForm action="/v1/admin/token-settings" method="PATCH" csrf={csrf} confirmation={{ consequence: 'Save these token settings?' }}
        bodyFrom={fields => ({ maxLifetimeMs: Math.floor(Number(fields.get('maxLifetimeHours')) * 3600000), ssoWindowMs: Math.round(Number(fields.get('ssoWindowDays')) * 86400000) })}>
        <VStack gap={3}>
          <label className="check"><input type="checkbox" name="mintingEnabled" data-type="boolean" defaultChecked={settings.mintingEnabled} /> Allow token creation</label>
          <Field label="Maximum lifetime in hours" inputID="token-max-lifetime">
            <input id="token-max-lifetime" className="input" type="number" name="maxLifetimeHours" min="0.01" step="any" defaultValue={settings.maxLifetimeHours} required />
          </Field>
          <Field label="SSO sign-in window in days" inputID="token-sso-window">
            <input id="token-sso-window" className="input" type="number" name="ssoWindowDays" min="1" max="30" step="any" defaultValue={settings.ssoWindowDays} required />
          </Field>
          <VStack gap={1}>
            <Text as="p" type="supporting">Tokens from SSO accounts pause after this long without an SSO sign-in and resume when the creator signs in again.</Text>
            <Text as="p" type="supporting">Disabling creation does not revoke existing tokens. The lifetime cap applies to new tokens.</Text>
          </VStack>
          <HStack justify="end"><ActionSubmit label="Save settings" variant="primary" /></HStack>
        </VStack>
      </ActionForm>
    </Panel>
  )
}

function TokenRow({ csrf, token }: { csrf: string, token: TokensProps['tokens'][number] }) {
  return (
    <TableRow data-token={token.id}>
      <TableHeaderCell scope="row">
        <VStack gap={0.5}>
          <Text type="label">{token.label}</Text>
          <Text type="supporting"><code>{token.id}</code></Text>
        </VStack>
      </TableHeaderCell>
      <TableCell data-label="Creator">{token.creator}</TableCell>
      <TableCell className="token-access">
        <VStack gap={1}>
          <Text>{`${token.writable ? 'Writes allowed' : 'Read-only'} · ${token.singleUse ? 'Single use' : 'Reusable'}`}</Text>
          <ul className="token-scope">
            {token.scope.map(item => (
              <li key={`${item.tool}:${item.commands?.join(',') ?? ''}`}>
                {`${item.tool}${item.instances ? ` (instances: ${item.instances.join(', ')})` : ''}: ${item.commands ? item.commands.join(', ') : 'Tool-wide'}`}
              </li>
            ))}
          </ul>
        </VStack>
      </TableCell>
      <TableCell data-label="Expires"><Time iso={token.expiresAt} /></TableCell>
      <TableCell><Badge label={token.status.word} variant={badgeVariants[token.status.tone]} /></TableCell>
      <TableCell className="actions-cell">
        {token.revocable && (
          <ActionForm action={`/v1/admin/tokens/${encodeURIComponent(token.id)}/revoke`} method="POST" csrf={csrf} confirmation={{ consequence: 'Revoke this token and its sessions?' }}>
            <ActionSubmit label="Revoke" variant="secondary" size="sm" className="revoke" />
          </ActionForm>
        )}
      </TableCell>
    </TableRow>
  )
}

export function Tokens({ csrf, settings, tokens }: TokensProps) {
  return (
    <VStack gap={4}>
      <Settings csrf={csrf} settings={settings} />
      <Panel title="All tokens" description="Tokens created by all users.">
        {tokens.length ? (
          <Table aria-label="All tokens" scrollWrapper={({ children }) => <div className="tokens-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Label', 'Creator', 'Access', 'Expires', 'Status'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>{tokens.map(token => <TokenRow key={token.id} csrf={csrf} token={token} />)}</TableBody>
          </Table>
        ) : <EmptyState title="No tokens" headingLevel={3} description="Tokens that people create on their Account page appear here." />}
      </Panel>
      <Panel title="Revoke all" description="End access for all tokens.">
        <ActionForm action="/v1/admin/tokens/revoke-all" method="POST" csrf={csrf} confirmation={{ consequence: 'Revoke all tokens and their sessions?' }}>
          <ActionSubmit label="Revoke all tokens" variant="secondary" className="revoke" />
        </ActionForm>
      </Panel>
    </VStack>
  )
}
