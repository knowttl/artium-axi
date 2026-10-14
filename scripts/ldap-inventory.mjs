import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import * as schemas from '../tools/node_modules/@knowttl/ldap-axi/dist/src/schema.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/ldap-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for ldap-axi')
// The release exports command schemas, but keeps its global flags and entry routes private.
// These reviewed flags mirror dist/src/cli.js; its digest binds the review to the pin.
const globals = { help: 'boolean', config: 'value', url: 'value', base: 'value', 'start-tls': 'boolean',
  'ca-file': 'value', 'ca-only': 'boolean', 'tls-no-verify': 'boolean', 'tls-max-version': 'value',
  'insecure-plaintext': 'boolean', anonymous: 'boolean', profile: 'value', auth: 'value',
  'gssapi-service': 'value', 'gssapi-protection': 'value' }
const unsafeOverrides = Object.keys(globals).filter(name => !['help', 'base'].includes(name))
const commands = [
  { command: 'home', flags: globals, positionalInput: false },
  { command: 'auth status', flags: { ...globals, offline: 'boolean' }, positionalInput: false },
  { command: 'entry search', flags: { ...globals, filter: 'value', scope: 'value', attributes: 'value',
    'page-size': 'value', 'max-rows': 'value', all: 'boolean' }, positionalInput: false },
  { command: 'entry show', flags: { ...globals, attributes: 'value', 'page-size': 'value' }, positionalInput: true },
  ...Object.entries({ 'user list': schemas.userListSchema, 'user show': schemas.userShowSchema,
    'user groups': schemas.userGroupsSchema, 'group list': schemas.groupListSchema,
    'group show': schemas.groupShowSchema, 'group members': schemas.groupMembersSchema }).map(([command, schema]) => {
    const combined = schemas.completeSchema(schema('ad'), schema('ldapv3'))
    return { command, flags: { ...globals,
      ...Object.fromEntries(combined.booleanFlags.map(name => [name, 'boolean'])),
      ...Object.fromEntries(combined.valueFlags.map(name => [name, 'value'])) },
    positionalInput: / (show|groups|members)$/.test(command) }
  }),
]
const data = { generatedBy: 'scripts/ldap-inventory.mjs', tool: 'ldap-axi', ...pin,
  parserEvidence: 'Installed pinned command schemas and reviewed CLI globals and entry routes',
  sources: ['package.json', 'README.md', 'axi-credential.schema.json', 'dist/src/cli.js', 'dist/src/schema.js',
    'dist/src/config.js', 'dist/src/secrets.js', 'dist/src/directory/auth.js', 'dist/src/directory/policy.js']
    .map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, packageRoot))).digest('hex') })),
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  adapterBoundary: { unsafeOverrides, blockedCommands: ['config', 'profile'],
    sensitiveFlags: ['base', 'filter', 'name', 'sam', 'upn', 'uid'],
    authentication: 'Stored simple-bind identity over verified LDAPS or StartTLS; no ambient ticket or keytab',
    inputs: { stdin: 'unsupported', files: 'unsupported', caFile: 'stored PEM materialized privately by host' },
    resources: { nodeHeapMiB: 128 }, nativeWrites: 'read-only upstream design' },
  discovery: { commands: ['entry', 'user', 'group', 'auth status'], example: ['user', 'list', '--limit', '1'],
    help: schemas.commandHelp('user list', schemas.userListSchema('ad'), schemas.userListSchema('ldapv3'), ['help', 'base']) },
  suggestionFields: ['help'], format: 'TOON', commands }
const destination = new URL('inventories/ldap-axi.json', root)
const contents = JSON.stringify(data, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: ldap-axi')
console.log(`inventory: ldap-axi ${pkg.version}, ${commands.length} commands`)
