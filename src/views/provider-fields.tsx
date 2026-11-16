import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'

export interface ProviderFieldsProps {
  kind: 'entra' | 'oidc'
  name: string
  identifier: string
}

export function ProviderFields({ kind, name, identifier }: ProviderFieldsProps) {
  const [fields, setFields] = useState({ name, identifier })
  return (
    <VStack gap={3}>
      {kind === 'oidc' && <input type="hidden" name="kind" value="oidc" />}
      <TextInput label="Provider name" id="provider-name" htmlName="name" value={fields.name} onChange={value => setFields({ ...fields, name: value })}
        description="Shown on the sign-in button." {...{ required: true, maxLength: 256 }} />
      {kind === 'entra'
        ? <TextInput label="Directory (tenant) ID" id="provider-tenantId" htmlName="tenantId" value={fields.identifier} onChange={value => setFields({ ...fields, identifier: value })}
          description="The directory tenant UUID of a single-tenant app. Changing it removes the stored credential and requires a new one." controlClassName="mono" {...{ required: true }} />
        : <TextInput label="Issuer URL" id="provider-issuer" htmlName="issuer" type="url" value={fields.identifier} onChange={value => setFields({ ...fields, identifier: value })}
          description="The exact HTTPS issuer, for example https://identity.example. Discovery reads its OpenID configuration over verified TLS at sign-in and does not follow redirects. Changing it removes the stored credential and requires a new one."
          controlClassName="mono" {...{ required: true }} />}
    </VStack>
  )
}
