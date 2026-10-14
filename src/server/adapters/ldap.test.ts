import { expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createLdapAdapter, ldapCredentialSchema, ldapManifest } from './ldap.js'
import { toolView } from '../../cli/views.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'

const reference = { id: 'synthetic-ldap', tool: 'ldap-axi' as const, revision: 1 }
const credential = { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap-password' }

test.each([
  credential,
  { ...credential, url: 'ldap://directory.test:389', startTls: true },
])('prepares a stored bind identity using SecretRefs and verified TLS: %j', async value => {
  const call = await createLdapAdapter({ getCredential: async () => value }).prepare(['user', 'list', '--limit', '1'], reference)
  expect(call.environment).toEqual({ ARTIUM_SECRET_0: credential.bindPassword })
  expect(call.secrets).toEqual([credential.bindPassword])
  expect(JSON.parse(call.files[0].content as string)).toEqual({ version: 1, defaultProfile: 'artium',
    profiles: { artium: { ...value, bindPassword: { env: 'ARTIUM_SECRET_0' } } } })
  expect(JSON.stringify(call.files)).not.toContain(credential.bindPassword)
})

test('materializes CA contents beside the profile with a path relative to the isolated runner', async () => {
  const call = await createLdapAdapter({ getCredential: async () => ({ ...credential, caFile: 'CANARY-ca-pem\nsynthetic-ca-line\n' }) }).prepare([], reference)
  expect(call.files[0]).toEqual({ name: 'ldap-axi/ldap-ca.pem', content: 'CANARY-ca-pem\nsynthetic-ca-line\n' })
  expect(JSON.parse(call.files[1].content as string).profiles.artium.caFile).toBe('ldap-axi/ldap-ca.pem')
})

test.each([
  { ...credential, auth: 'auto' }, { ...credential, auth: 'gssapi' }, { ...credential, auth: undefined },
  { ...credential, bindDn: undefined }, { ...credential, bindPassword: undefined },
  { ...credential, bindPassword: '   ' }, { ...credential, bindPassword: { env: 'OTHER' } },
  { ...credential, url: 'ldap://directory.test:389' },
  { ...credential, url: 'ldap://directory.test:389', startTls: false },
  { ...credential, url: 'ldaps://reader:password@directory.test:636' },
  { ...credential, url: 'ldaps://' }, { ...credential, url: 'ldaps://directory.test/base' },
  { ...credential, gssapiService: 'ldap@directory.test' }, { ...credential, keytab: '/private/keytab' },
])('refuses unusable hosted bind credentials: %j', async value => {
  expect(ldapCredentialSchema.safeParse(value).success).toBe(false)
  await expect(createLdapAdapter({ getCredential: async () => value }).prepare([], reference))
    .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
})

test.each([
  ...ldapManifest.unsafeOverrides.flatMap(flag => [['user', 'list', `--${flag}=other`], ['user', 'list', `--${flag}`, 'other']]),
  ['config', 'path'], ['profile', 'list'], ['auth', 'login'], ['entry', 'delete', 'uid=person'],
].map(args => [args]))('refuses credential and connection overrides before secret retrieval: %j', async args => {
  const getCredential = vi.fn()
  await expect(createLdapAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([
  ['user', 'list', '--limit'], ['user', 'list', '--limit', '1', '--limit', '2'],
  ['user', 'list', '--all=false'], ['user', 'show'], ['user', 'list', 'extra'],
  ['user', 'show', '--fields', 'name', 'uid=person'],
].map(args => [args]))('refuses malformed arguments before secret retrieval: %j', async args => {
  const getCredential = vi.fn()
  await expect(createLdapAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('unknown flags include the valid hosted flags', () => {
  expect(() => createLdapAdapter({ getCredential: vi.fn() }).validateArgs(['user', 'list', '--unknown']))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: 'Unknown flag --unknown for ldap-axi user list.',
      next: expect.stringContaining('--limit') }))
})

test.each([
  { stdin: '' }, { files: [{ name: 'input', contentBase64: 'eA==' }] },
])('refuses unsupported input before secret retrieval: %j', async input => {
  const getCredential = vi.fn()
  await expect(createLdapAdapter({ getCredential }).prepare(['user', 'list'], reference, input))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('a reference for another tool cannot retrieve LDAP credentials', async () => {
  const getCredential = vi.fn()
  await expect(createLdapAdapter({ getCredential }).prepare([], { ...reference, tool: 'mg-axi' }))
    .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('LDAP discovery advertises hosted reads without credential overrides', () => {
  const output = toolView({ name: 'ldap-axi', status: 'unconfigured', version: '0.1.4' })
  expect(output).toContain('artium-axi ldap-axi user list --limit 1')
  expect(output).toContain('--fields')
  expect(output).not.toMatch(/--(?:auth|url|config|profile|ca-file|tls-no-verify)\b/)
})

test('published LDAP help hosts usage and examples while hiding managed flags', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js', 'user', 'list', '--help'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const output = rewriteSuggestions(result.stdout, 'ldap-axi')
  expect(output).toContain('Usage: artium-axi ldap-axi user list [flags]')
  expect(output).toContain('use artium-axi ldap-axi entry search')
  expect(output).toContain('--limit')
  expect(output).not.toMatch(/--(?:auth|url|config|profile|ca-file|tls-no-verify)\b/)
  expect(rewriteSuggestions(output, 'ldap-axi')).toBe(output)
})
