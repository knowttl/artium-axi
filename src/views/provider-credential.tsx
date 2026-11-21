import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { ActionForm, Revision } from './action-form.js'
import { CredentialEditor, type CredentialEditorProps } from './credential-editor.js'
import { Panel } from './panel.js'
import { LastChange } from './time.js'

export interface ProviderCredentialProps {
  configured: boolean
  revision: number
  changed: { actor: string, at: string | null, revision: number } | null
  editor: CredentialEditorProps
}

export function ProviderCredential({ csrf, api, providerRevision, credential }: { csrf: string, api: string, providerRevision: number, credential: ProviderCredentialProps }) {
  const { configured, revision, changed, editor } = credential
  return (
    <ActionForm action={`${api}/credential`} method="PATCH" csrf={csrf}
      confirmation={{ consequence: 'Save the encrypted provider credential and disable this provider, keeping omitted secrets only for the same identity? Review configuration and enable it again afterwards.' }}>
      <Panel title="App credential" description={configured ? 'Saved. Secrets are never displayed.' : 'Not saved yet. Secrets are never displayed.'}
        actions={<Badge label={configured ? 'Saved' : 'Needs credential'} variant={configured ? 'success' : 'warning'} />}>
        <VStack gap={3}>
          {changed && <LastChange {...changed} />}
          <Text as="p" type="supporting">Certificate authentication is preferred. Upload one PEM containing the certificate and matching unencrypted private key; the SHA-256 fingerprint is calculated automatically. Client secrets are accepted but are less secure than certificates.</Text>
          <Revision value={revision} />
          <input type="hidden" name="expectedProviderRevision" data-type="number" value={providerRevision} />
          <CredentialEditor {...editor} />
          <HStack justify="end"><Button type="submit" label="Save credential" variant="primary" /></HStack>
        </VStack>
      </Panel>
    </ActionForm>
  )
}
