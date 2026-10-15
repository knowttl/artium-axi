import { createPrivateKey } from 'node:crypto'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'

const schema = z.discriminatedUnion('auth', [
  z.object({ auth: z.literal('secret'), tenantId: z.uuid(), clientId: z.uuid(), clientSecret: z.string().refine(value => value.trim().length > 0) }),
  z.object({ auth: z.literal('certificate'), tenantId: z.uuid(), clientId: z.uuid(), privateKey: z.string().min(1), thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
])

// Activation and sign-in share the same local configuration requirements.
export function entraCredential(issuer: string, input: unknown) {
  try {
    const value = schema.parse(input)
    if (issuer !== `https://login.microsoftonline.com/${value.tenantId}/v2.0`) throw new Error('Tenant mismatch')
    if (value.auth === 'certificate' && createPrivateKey(value.privateKey).asymmetricKeyType !== 'rsa') throw new Error('RSA key required')
    return value
  } catch {
    throw new ArtiumError('INVALID_INPUT', 'The provider requires a valid matching Entra credential.', 'Save the application client ID and a client secret or RSA certificate credential for this tenant, then try again.')
  }
}
