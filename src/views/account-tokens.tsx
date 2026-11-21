import { Badge } from '@astryxdesign/core/Badge'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, ActionSubmit } from './action-form.js'
import { CreatedTokenDialog } from './created-token.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface AccountTokensProps {
  mintingEnabled: boolean
  maxLifetimeHours: number
  choices: { tool: string, instances: string[], commands: string[] }[]
  tokens: { id: string, label: string, writable: boolean, singleUse: boolean, expiresAt: string, status: Status, revocable: boolean,
    scope: { tool: string, instances?: string[], commands?: string[] }[] }[]
}

function tokenBody(fields: FormData, choices: AccountTokensProps['choices']) {
  const tools = choices.flatMap(({ tool }) => {
    const commands = fields.getAll(`command:${tool}`)
    const instances = fields.getAll(`instance:${tool}`)
    const scope = instances.length ? { instances } : {}
    return [...fields.has(`tool:${tool}`) ? [{ tool, ...scope }] : [], ...commands.length ? [{ tool, commands, ...scope }] : []]
  })
  const expiresAt = fields.get('expiryType') === 'date' ? new Date(String(fields.get('expiryDate'))).getTime() : Date.now() + Math.floor(Number(fields.get('duration')) * 3600000)
  return { label: fields.get('label'), scope: { tools }, expiresAt }
}

function CreateForm({ csrf, maxLifetimeHours, choices }: { csrf: string } & Pick<AccountTokensProps, 'maxLifetimeHours' | 'choices'>) {
  const [label, setLabel] = useState('')
  return (
    <ActionForm action="/v1/account/tokens" method="POST" csrf={csrf} createdToken bodyFrom={fields => tokenBody(fields, choices)}>
      <VStack gap={3}>
        <TextInput label="Label" htmlName="label" value={label} onChange={setLabel} {...{ required: true, maxLength: 100 }} />
        <label className="field">
          <span>Expiry type</span>
          <select className="select" name="expiryType"><option value="duration">Duration</option><option value="date">Date and time</option></select>
        </label>
        <label className="field">
          <span>Duration in hours</span>
          <input className="input" name="duration" type="number" min="0.01" step="any" defaultValue="1" />
        </label>
        <label className="field">
          <span>Expiry date and time</span>
          <input className="input" name="expiryDate" type="datetime-local" />
        </label>
        <Text as="p" type="supporting">{`Maximum lifetime: ${maxLifetimeHours} hours. The server refuses longer lifetimes.`}</Text>
        <label className="check"><input name="readOnly" type="checkbox" data-type="boolean" defaultChecked /> Read-only</label>
        <label className="check"><input name="reusable" type="checkbox" data-type="boolean" /> Reusable token</label>
        <Text as="p" type="supporting">Read-only follows tool inventory labels; some reads send data to external services. Writable SSH access reaches every granted host, including sudo. Credential-issuing commands require an exact selection and can create credentials that token revocation does not end.</Text>
        <fieldset className="options">
          <legend>Tool and exact command access</legend>
          {choices.length ? choices.map(({ tool, instances, commands }) => (
            <details key={tool} className="ops-group">
              <summary>{tool}</summary>
              <div className="ops-body">
                {instances.length > 0 && (
                  <fieldset>
                    <legend>Instances (none selected allows every instance you can use)</legend>
                    {instances.map(instance => <label key={instance} className="check"><input type="checkbox" name={`instance:${tool}`} value={instance} /> <code>{instance}</code></label>)}
                  </fieldset>
                )}
                <label className="check"><input type="checkbox" name={`tool:${tool}`} /> All permitted commands</label>
                {commands.map(command => <label key={command} className="check"><input type="checkbox" name={`command:${tool}`} value={command} /> <code>{command}</code></label>)}
              </div>
            </details>
          )) : <Text as="p">No enabled tools granted.</Text>}
        </fieldset>
        <HStack><ActionSubmit label="Create token" variant="primary" /></HStack>
      </VStack>
    </ActionForm>
  )
}

function TokenRow({ csrf, token }: { csrf: string, token: AccountTokensProps['tokens'][number] }) {
  return (
    <TableRow data-token={token.id}>
      <TableHeaderCell scope="row">
        <VStack gap={0.5}>
          <Text type="label">{token.label}</Text>
          <Text type="supporting"><code>{token.id}</code></Text>
        </VStack>
      </TableHeaderCell>
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
          <ActionForm action={`/v1/account/tokens/${encodeURIComponent(token.id)}/revoke`} method="POST" csrf={csrf} confirmation={{ consequence: 'Revoke this token and its sessions?' }}>
            <ActionSubmit label="Revoke" variant="secondary" size="sm" className="revoke" />
          </ActionForm>
        )}
      </TableCell>
    </TableRow>
  )
}

export function AccountTokens({ csrf, mintingEnabled, maxLifetimeHours, choices, tokens }: AccountTokensProps & { csrf: string }) {
  return (
    <Panel title="Temporary access tokens" description="Grant a subset of your access to another user or agent.">
      <VStack gap={4}>
        {mintingEnabled ? (
          <>
            <CreateForm csrf={csrf} maxLifetimeHours={maxLifetimeHours} choices={choices} />
            <CreatedTokenDialog />
          </>
        ) : <Text as="p">Token creation is disabled by an administrator. Existing tokens continue to work.</Text>}
        {tokens.length ? (
          <Table aria-label="Your tokens" scrollWrapper={({ children }) => <div className="tokens-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Label', 'Access', 'Expires', 'Status'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>{tokens.map(token => <TokenRow key={token.id} csrf={csrf} token={token} />)}</TableBody>
          </Table>
        ) : <Text as="p" type="supporting">No tokens.</Text>}
      </VStack>
    </Panel>
  )
}
