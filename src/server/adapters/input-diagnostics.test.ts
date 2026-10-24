import { expect, test, vi } from 'vitest'
import { createHybridAdapter } from './hybrid.js'
import { createTenableAdapter } from './tenable.js'
import { createMgAdapter } from './mg.js'
import { createAwxAdapter } from './awx.js'
import { createLdapAdapter } from './ldap.js'
import { createAdoAdapter } from './ado.js'
import { createAzAdapter } from './az.js'

const source = { getCredential: vi.fn() }
const adapters = [createHybridAdapter(source, '/tmp/synthetic-writes.log'), createTenableAdapter(source, '/tmp/synthetic-writes.log'),
  createMgAdapter(source, '/tmp/synthetic-writes.log'), createAwxAdapter(source), createLdapAdapter(source),
  createAdoAdapter(source), createAzAdapter(source, '/tmp/synthetic-writes.log')]

test.each([
  ['hybrid-axi', ['hash']], ['hybrid-axi', ['hash', '--help']], ['hybrid-axi', ['qouta']],
  ['tenable-axi', ['asset']], ['tenable-axi', ['asset', '--help']], ['tenable-axi', ['assset']],
  ['mg-axi', ['entra']], ['mg-axi', ['entra', '--help']], ['mg-axi', ['enttra']],
  ['mg-axi', ['api']], ['mg-axi', ['api', '--help']], ['mg-axi', ['api', 'gte', '/users']],
  ['awx-axi', ['job']], ['awx-axi', ['jbo']], ['ldap-axi', ['user']], ['ldap-axi', ['user', '--help']],
  ['ldap-axi', ['usre']], ['ado-axi', ['pipline']], ['az-axi', ['resorce']],
] as const)('%s names unknown or incomplete command %j', (tool, args) => {
  expect(() => adapters.find(adapter => adapter.name === tool)!.validateArgs(args))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining(args[0]),
      next: expect.stringContaining('artium-axi') }))
  expect(source.getCredential).not.toHaveBeenCalled()
})

test.each([
  ['hybrid-axi', ['quota', '--synthetic-unknown=value']], ['mg-axi', ['entra', 'user', 'list', '--synthetic-unknown=value']],
  ['hybrid-axi', ['--synthetic-unknown']], ['tenable-axi', ['--synthetic-unknown']], ['az-axi', ['--synthetic-unknown']],
  ['awx-axi', ['job', 'list', '--synthetic-unknown=value']],
] as const)('%s names an unknown flag %j', (tool, args) => {
  expect(() => adapters.find(adapter => adapter.name === tool)!.validateArgs(args))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('--synthetic-unknown'),
      next: expect.stringContaining('--help') }))
})

test.each(['hybrid-axi', 'tenable-axi', 'az-axi'])('%s names a home flag typo before credential retrieval', async tool => {
  const adapter = adapters.find(adapter => adapter.name === tool)!
  const error = { code: 'INVALID_INPUT', message: `Unknown flag --hepl for ${tool} home.` }
  expect(() => adapter.validateArgs(['--hepl'])).toThrow(expect.objectContaining(error))
  await expect(adapter.prepare(['--hepl'], { id: 'synthetic', tool: adapter.name, revision: 1 })).rejects.toMatchObject(error)
  expect(source.getCredential).not.toHaveBeenCalled()
})

test.each([
  { tool: 'ado-axi', args: ['project', 'list', '-x'], flag: '-x' },
  { tool: 'ado-axi', args: ['home', '-x'], flag: '-x' },
  { tool: 'ado-axi', args: ['-x'], flag: '-x' },
  { tool: 'ado-axi', args: ['project', 'list', '--hepl'], flag: '--hepl' },
  { tool: 'ado-axi', args: ['--hepl'], flag: '--hepl' },
  { tool: 'ldap-axi', args: ['user', 'list', '-x'], flag: '-x' },
  { tool: 'ldap-axi', args: ['auth', 'status', '-x'], flag: '-x' },
  { tool: 'ldap-axi', args: ['-x'], flag: '-x' },
  { tool: 'ldap-axi', args: ['user', 'list', '--hepl'], flag: '--hepl' },
  { tool: 'ldap-axi', args: ['--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['auth', 'status', '--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['auth', 'status', '-x'], flag: '-x' },
  { tool: 'tenable-axi', args: ['auth', 'status', '--fields', 'profile', '--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['home', '--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['home', '-x'], flag: '-x' },
  { tool: 'tenable-axi', args: ['-x'], flag: '-x' },
  { tool: 'tenable-axi', args: ['card', 'list', '--full', '--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['card', 'list', '--all', '--hepl'], flag: '--hepl' },
  { tool: 'tenable-axi', args: ['tag', 'value', 'create', '--execute', '--hepl'], flag: '--hepl' },
] as const)('$tool names $flag before credential retrieval: $args', async ({ tool, args, flag }) => {
  const adapter = adapters.find(adapter => adapter.name === tool)!
  const error = { code: 'INVALID_INPUT', message: expect.stringContaining(flag) }
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining(error))
  await expect(adapter.prepare(args, { id: 'synthetic', tool, revision: 1 })).rejects.toMatchObject(error)
  expect(source.getCredential).not.toHaveBeenCalled()
})

test('LDAP distinguishes trailing positional arguments from flags', () => {
  const adapter = adapters.find(adapter => adapter.name === 'ldap-axi')!
  expect(() => adapter.validateArgs(['user', 'list', '--help', 'extra']))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: 'Unexpected argument "extra" for ldap-axi user list.' }))
})
