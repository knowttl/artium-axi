import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useRef, useState } from 'react'
import { ActionForm, ActionSubmit, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'

export interface SshCredentialsProps {
  csrf: string
  credentials: { id: string, revision: number }[]
}

const proof = <input type="hidden" name="confirm" data-type="boolean" value="true" />
const passwordHint = 'A short password will also be withheld from command output and will refuse commands whose text contains it (SECRET_IN_COMMAND), so a longer password avoids unexpected refusals. No minimum length is enforced.'

function SecretsForm({ csrf, credential, prefix, method }: { csrf: string, credential?: { id: string, revision: number }, prefix: string, method: 'key' | 'password' }) {
  const [id, setId] = useState('')
  return (
    <ActionForm action="/v1/admin/ssh/credential" method="POST" csrf={csrf}
      confirmation={{ consequence: 'Save a replacement SSH credential? Every secret field is replaced, and existing credential revisions become stale.' }}>
      {proof}
      <VStack gap={3}>
        <Revision value={credential?.revision ?? 0} />
        {credential ? <input type="hidden" name="id" value={credential.id} />
          : <TextInput label="Credential ID" id={`${prefix}-${method}-id`} htmlName="id" value={id} onChange={setId} {...{ required: true }} />}
        {method === 'key' ? (
          <>
            <Field label="Private key" inputID={`${prefix}-privateKey`}>
              <textarea id={`${prefix}-privateKey`} name="privateKey" rows={6} autoComplete="off" required className="input mono" />
            </Field>
            <Field label="Passphrase (optional)" inputID={`${prefix}-passphrase`}>
              <input id={`${prefix}-passphrase`} name="passphrase" type="password" autoComplete="new-password" className="input" />
            </Field>
          </>
        ) : (
          <Field label="Password" inputID={`${prefix}-password`} description={passwordHint} descriptionID={`${prefix}-password-hint`}>
            <input id={`${prefix}-password`} name="password" type="password" autoComplete="off" required aria-describedby={`${prefix}-password-hint`} className="input" />
          </Field>
        )}
        <HStack><ActionSubmit label={credential ? 'Replace credential' : 'Save credential'} variant="primary" /></HStack>
      </VStack>
    </ActionForm>
  )
}

function Methods({ csrf, credential }: { csrf: string, credential?: { id: string, revision: number } }) {
  const prefix = credential ? `stored-credential-${credential.id}` : 'new-credential'
  return (
    <VStack gap={3}>
      <Text as="p" type="supporting">Choose one authentication method. Set the username on the host account binding.</Text>
      <details className="all-fields" name={`${prefix}-auth`} open>
        <summary className="btn btn-secondary btn-sm">Use a private key</summary>
        <SecretsForm csrf={csrf} credential={credential} prefix={prefix} method="key" />
      </details>
      <details className="all-fields" name={`${prefix}-auth`}>
        <summary className="btn btn-secondary btn-sm">Use a password</summary>
        <SecretsForm csrf={csrf} credential={credential} prefix={prefix} method="password" />
      </details>
    </VStack>
  )
}

export function SshCredentials({ csrf, credentials }: SshCredentialsProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const clear = () => {
      for (const secret of root.current?.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea[name=privateKey], input[name=passphrase], input[name=password]') ?? []) secret.value = ''
    }
    window.addEventListener('pagehide', clear)
    return () => window.removeEventListener('pagehide', clear)
  }, [])
  return (
    <div ref={root}>
      <VStack gap={4}>
        {credentials.map(credential => (
          <Panel key={credential.id} title={credential.id} description={`Revision ${credential.revision}`}>
            <VStack gap={4}>
              <Methods csrf={csrf} credential={credential} />
              <HStack justify="end">
                <ActionForm action="/v1/admin/ssh/credential-delete" method="POST" csrf={csrf}
                  confirmation={{ consequence: 'Delete this credential and remove all its host bindings?', typedName: credential.id }}>
                  {proof}
                  <Revision value={credential.revision} />
                  <input type="hidden" name="id" value={credential.id} />
                  <ActionSubmit label="Delete credential" variant="ghost" className="danger" icon={<Icon name="trash" />} />
                </ActionForm>
              </HStack>
            </VStack>
          </Panel>
        ))}
        <Panel title="New encrypted credential" description="Keys, passphrases and passwords are never displayed. Replacements require every secret again; blank fields do not retain stored values.">
          <Methods csrf={csrf} />
        </Panel>
      </VStack>
    </div>
  )
}
