import { isIP } from 'node:net'
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
const revision = z.number().int().min(0)
const confirmed = z.object({ expectedRevision: revision, confirm: z.literal(true) })
export const sshHostInput = confirmed.extend({ id,
  address: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/), port: z.number().int().min(1).max(65535),
  approvedHostKeys: z.array(z.string().regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,2}$/)).min(1).max(2),
  allowedAddresses: z.array(z.string().refine(value => Boolean(isIP(value)))).min(1),
  independentVerification: z.string().trim().min(1).max(1024), enabled: z.boolean(), readOnly: z.boolean(),
  commandSeconds: z.number().int().min(1).max(600), outputBytes: z.number().int().min(0).max(1048576),
  idleMinutes: z.number().int().min(1).max(60),
}).strict().refine(value => new Set(value.approvedHostKeys).size === value.approvedHostKeys.length
  && new Set(value.allowedAddresses).size === value.allowedAddresses.length)
export const sshBindingInput = confirmed.extend({ host: id, sudo: z.boolean(),
  username: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/), credential: id }).strict()
export const sshGrantInput = confirmed.extend({ host: id, user: z.string().min(1).max(256),
  shell: z.boolean(), sudo: z.boolean() }).strict().refine(value => !value.sudo || value.shell)
export const sshCredentialInput = confirmed.extend({ id, privateKey: z.string().min(1).max(65536).regex(/\S/),
  passphrase: z.string().max(4096).refine(value => !value || /\S/.test(value)).optional().transform(value => value === '' ? undefined : value) }).strict()
export const sshDeleteInput = confirmed.extend({ id }).strict()

export interface SshAdminHost {
  id: string, address: string, port: number, approvedHostKeys: string[], allowedAddresses: string[],
  enabled: boolean, readOnly: boolean, commandSeconds: number, outputBytes: number, idleMinutes: number,
  independentVerification: string, revision: number,
}
