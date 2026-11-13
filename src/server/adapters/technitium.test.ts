import { expect, test } from 'vitest'
import inventory from '../../../tools/inventories/technitium-axi.json' with { type: 'json' }
import { createTechnitiumAdapter, technitiumWritePolicy } from './technitium.js'
import type { RunnerInput } from '../runner/input.js'

const reference = { id: 'synthetic-credential', tool: 'technitium-axi' as const, revision: 1 }
const input = (parameters: Record<string, unknown> = {}, extra = {}): RunnerInput => ({ files: [{ name: 'input.json',
  contentBase64: Buffer.from(JSON.stringify({ parameters, ...extra })).toString('base64') }] })
const source = (settings = {}) => ({ getSettings: () => settings,
  getCredential: async () => { throw new Error('Credential accessed before refusal') } })

test.each([
  ['user', 'login'], ['auth', 'login'], ['user', 'create-token', '--input-file', 'input.json'],
  ['allowed', 'add', '--input-file', 'input.json', '--reconcile-profile', 'alternate'],
  ['allowed', 'add', '--input-file', 'input.json', '--profile=alternate'],
  ['allowed', 'add', '--input-file', 'input.json', '--config', '/server/config.json'],
])('refuses acquisition and caller profile selection before credentials: %j', async (...args) => {
  await expect(createTechnitiumAdapter(source(), '/private/writes.log').prepare(args, reference,
    input({ user: 'synthetic-user', pass: { env: 'TECHNITIUM_INPUT_PASS' } }, { secrets: { TECHNITIUM_INPUT_PASS: 'CANARY-private' } })))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each(inventory.writeContracts)('requires both host and native grants before credentials for $command', async contract => {
  const operation = contract.id === 'OP-077' ? 'OP-077.import' : contract.id
  const args = [...contract.command.split(' '), '--input-file', 'input.json']
  const body = input(contract.id === 'OP-077' ? { import: true } : {})
  for (const settings of [{}, { writes: { allowWrites: true, operations: [operation] } },
    { hostWrites: { allowWrites: true, operations: [operation] } },
    { writes: { allowWrites: true, operations: [operation] }, hostWrites: { allowWrites: true, operations: [] } },
    { writes: { allowWrites: false, operations: [operation] }, hostWrites: { allowWrites: true, operations: [operation] } }]) {
    await expect(createTechnitiumAdapter(source(settings), '/private/writes.log').prepare(args, reference, body))
      .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  }
})

test('read-only DNS resolution does not require import grants', () => {
  const adapter = createTechnitiumAdapter(source(), '/private/writes.log')
  expect(() => adapter.authorizeOperation!('dns-client resolve', {}, ['dns-client', 'resolve', '--input-file', 'input.json'],
    input({ domain: 'synthetic.test' }))).not.toThrow()
})

test('host Write updates preserve the separate native grants', () => {
  const settings = { writes: { allowWrites: false, operations: ['OP-057'] } }
  expect(technitiumWritePolicy.update(settings, { enabled: true, operations: ['OP-057'], expectedRevision: 0 })).toEqual({ ...settings,
    hostWrites: { allowWrites: true, operations: ['OP-057'] } })
})

test.each([
  { parameters: { domain: 'synthetic.test', proxyPassword: 'inline-secret' } },
  { parameters: { domain: 'synthetic.test', proxyPassword: { env: 'SERVER_SECRET' } } },
  { parameters: { domain: 'synthetic.test', proxyPassword: { file: '/server/secret' } } },
])('rejects inline operation secrets and server file references before credentials: %j', async body => {
  await expect(createTechnitiumAdapter(source(), '/private/writes.log').prepare(['allowed', 'add', '--input-file', 'input.json'], reference,
    { files: [{ name: 'input.json', contentBase64: Buffer.from(JSON.stringify(body)).toString('base64') }] }))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test('rejects a server upload path before credential access', async () => {
  await expect(createTechnitiumAdapter(source(), '/private/writes.log').prepare(['zone', 'import', '--input-file', 'input.json'], reference,
    input({ zone: 'synthetic.test' }, { upload: { file: '/server/archive' } }))).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})
