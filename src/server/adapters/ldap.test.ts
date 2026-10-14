import { expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createLdapAdapter, ldapCredentialSchema, ldapManifest } from './ldap.js'
import { toolView } from '../../cli/views.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import inventory from '../../../tools/inventories/ldap-axi.json' with { type: 'json' }

const reference = { id: 'synthetic-ldap', tool: 'ldap-axi' as const, revision: 1 }
const credential = { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap-password' }
const parserScript = 'import { parse } from "./tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js"; process.stdout.write(JSON.stringify(parse(process.argv.slice(2)).flags))'

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

test.each(inventory.commands)('published $command help hosts commands and managed credentials', route => {
  const args = route.command === 'home' ? [] : route.command.split(' ')
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js', ...args, '--help'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const output = rewriteSuggestions(result.stdout, 'ldap-axi')
  if (route.command !== 'home') expect(output).toContain(`Usage: artium-axi ldap-axi ${route.command} `)
  expect(output).toContain('Artium uses stored simple-bind credentials over verified LDAPS or StartTLS')
  expect(output).not.toMatch(new RegExp(`--(?:${ldapManifest.unsafeOverrides.join('|')})\\b`))
  expect(output).not.toMatch(/(?<!artium-axi )ldap-axi\b|Authentication defaults to auto|GSSAPI transport|profile list|config path/)
  expect(rewriteSuggestions(output, 'ldap-axi')).toBe(output)
})

test.each(inventory.commands.flatMap(route => Object.entries(route.flags)
  .filter(([flag, type]) => type === 'value' && !ldapManifest.unsafeOverrides.includes(flag))
  .map(([flag]) => ({ route, flag }))))('$route.command preserves the complete inline $flag value', async ({ route, flag }) => {
  const args = route.command === 'home' ? [] : route.command.split(' ')
  if (route.positionalInput) args.push('uid=synthetic,ou=people')
  const value = 'synthetic=value=with=equals'
  const call = await createLdapAdapter({ getCredential: async () => credential })
    .prepare([...args, `--${flag}=${value}`, '--help'], reference)
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parserScript, '--', 'package.json', ...call.args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)[flag]).toBe(value)
  expect(call.args).toEqual([...args, `--${flag}`, value, '--help'])
})

test('preserves an empty inline root DSE base', async () => {
  const call = await createLdapAdapter({ getCredential: async () => credential })
    .prepare(['entry', 'search', '--base=', '--scope=base'], reference)
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parserScript, '--', 'package.json', ...call.args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ base: '', scope: 'base' })
})
