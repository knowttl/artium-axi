import { createPrivateKey } from 'node:crypto'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'

const clientId = z.string().trim().min(1).max(256)
const schema = z.discriminatedUnion('auth', [
  z.strictObject({ auth: z.literal('secret'), clientId, clientSecret: z.string().refine(value => value.trim().length > 0) }),
  z.strictObject({ auth: z.literal('certificate'), clientId, privateKey: z.string().min(1),
    thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
])

export function oidcCredential(input: unknown) {
  try {
    const value = schema.parse(input)
    if (value.auth === 'certificate' && createPrivateKey(value.privateKey).asymmetricKeyType !== 'rsa') throw new Error('RSA key required')
    return value
  } catch {
    throw new ArtiumError('INVALID_INPUT', 'The provider requires a valid OIDC credential.',
      'Save the application client ID and a client secret or RSA certificate credential, then try again.')
  }
}
