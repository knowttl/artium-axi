import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test, vi } from 'vitest'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { Runner } from '../../src/server/runner/runner.js'
import type { RunnerInput } from '../../src/server/runner/input.js'

const credential = { mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
  tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002',
  enabledPacks: ['entra', 'mail'] }
const reference = { id: 'synthetic-mail', tool: 'mg-axi' as const, revision: 1 }
const profile = () => loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
const rule = JSON.stringify({ displayName: 'Reviewed', sequence: 1, isEnabled: true,
  conditions: { subjectContains: ['Synthetic'] }, actions: { markAsRead: true } })
const upload = (text = rule): RunnerInput => ({ files: [{ name: 'rule.json', contentBase64: Buffer.from(text).toString('base64') }] })
const writes = [
  { command: 'mail message tag', flags: ['--ids', 'synthetic-message', '--add', 'Reviewed'], confirm: 'synthetic-message' },
  { command: 'mail message flag', flags: ['--ids', 'synthetic-message', '--status', 'flagged'], confirm: 'synthetic-message' },
  { command: 'mail message mark', flags: ['--ids', 'synthetic-message', '--state', 'read'], confirm: 'synthetic-message' },
  { command: 'mail message move', flags: ['--ids', 'synthetic-message', '--destination', 'archive'], confirm: 'synthetic-message' },
  { command: 'mail message copy', flags: ['--ids', 'synthetic-message', '--destination', 'archive'], confirm: 'synthetic-message' },
  { command: 'mail message trash', flags: ['--ids', 'synthetic-message'], confirm: 'synthetic-message' },
  { command: 'mail folder create', flags: ['--name', 'Reviewed'], confirm: 'Reviewed' },
  { command: 'mail folder delete', flags: ['--ids', 'custom-folder'], confirm: 'custom-folder' },
  { command: 'mail category create', flags: ['--name', 'Reviewed', '--color', 'preset4'], confirm: 'Reviewed' },
  { command: 'mail rule create', flags: ['--file', 'rule.json'], confirm: 'Reviewed', input: upload() },
  { command: 'mail rule update', flags: ['--ids', 'synthetic-rule', '--file=rule.json'], confirm: 'synthetic-rule', input: upload() },
  { command: 'mail rule delete', flags: ['--ids', 'synthetic-rule'], confirm: 'synthetic-rule' },
]

async function withMail(check: (run: (args: string[], input?: RunnerInput, settings?: object) => Promise<Record<string, any>>,
  journal: () => any[]) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'artium-mail-writes-'))
  const runner = await Runner.create(join(directory, 'calls'))
  const log = join(directory, 'writes.log')
  const run = async (args: string[], input: RunnerInput = {}, settings: object = {
    writes: { allowWrites: true, operations: writes.map(write => write.command.replaceAll(' ', '.')) },
  }) => {
    const adapter = createMgAdapter({ getCredential: async () => ({ ...credential, ...settings }) }, log, profile())
    const call = await adapter.prepare(args, reference, input)
    const result = await runner.run('synthetic-user', process.execPath,
      [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args],
      call.environment, call.secrets, call.limits,
      { ...input, fileArguments: call.fileArguments?.map(index => index + 1) }, call.files)
    expect(result.stderr).toBe('')
    return decode(result.stdout) as Record<string, any>
  }
  try { await check(run, () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))) }
  finally { await runner.shutdown(); rmSync(directory, { recursive: true, force: true }) }
}

test.each(writes)('$command previews then executes only its selected operation with an intent/outcome journal', async write => {
  await withMail(async (run, journal) => {
    const args = [...write.command.split(' '), '--mailbox', 'mailbox@contoso.example', ...write.flags]
    const settings = { writes: { allowWrites: true, operations: [write.command.replaceAll(' ', '.')] } }
    const preview = await run(args, write.input, settings)
    expect(preview).toMatchObject({ complete: true, fakeSends: 0, results: [{ status: 'dry-run' }] })
    const result = await run([...args, '--execute', '--confirm', write.confirm], write.input, settings)
    expect(result).toMatchObject({ complete: true, fakeSends: 1, results: [{ status: 'success', id: write.confirm }] })
    expect(result.fakeReads).toBeGreaterThan(0)
    expect(journal().map(row => row.kind)).toEqual(['intent', 'outcome'])
    expect(journal()[1].outcome).toBe('SUCCESS')
  })
})

test.each(writes)('$command refuses disabled writes and an unselected operation before native credentials', async write => {
  await withMail(async run => {
    const args = [...write.command.split(' '), '--mailbox', 'mailbox@contoso.example', ...write.flags,
      '--execute', '--confirm', write.confirm]
    expect(await run(args, write.input, {})).toMatchObject({ error: { code: 'WRITES_DISABLED' }, fakeSends: 0, credentialCalls: 0 })
    expect(await run(args, write.input, { writes: { allowWrites: true, operations: ['entra.user.update'] } }))
      .toMatchObject({ error: { code: 'OPERATION_NOT_WRITABLE' }, fakeSends: 0, credentialCalls: 0 })
  })
})

test.each(writes)('$command requires the mail pack and application credentials', async write => {
  const adapter = createMgAdapter({ getCredential: async () => ({ ...credential, enabledPacks: ['entra'] }) }, '/tmp/synthetic.log', profile())
  const args = [...write.command.split(' '), '--mailbox', 'mailbox@contoso.example', ...write.flags]
  await expect(adapter.prepare(args, reference, write.input)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  const delegated = createMgAdapter({ getCredential: async () => ({ mode: 'delegated' }) }, '/tmp/synthetic.log', profile())
  await expect(delegated.prepare(args, reference, write.input)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test.each([
  { ids: 'first,second', confirm: 'second,first', code: 'CONFIRM_MISMATCH' },
  { ids: 'first,second', confirm: 'first', code: 'CONFIRM_MISMATCH' },
  { ids: Array.from({ length: 21 }, (_, index) => `id${index}`).join(','), confirm: 'first', code: 'VALIDATION_ERROR' },
])('ordered confirmation and target cap refuse $ids without credentials', async ({ ids, confirm, code }) => {
  await withMail(async run => {
    expect(await run(['mail', 'message', 'trash', '--mailbox', 'mailbox@contoso.example', '--ids', ids,
      '--execute', '--confirm', confirm])).toMatchObject({ error: { code }, fakeSends: 0, credentialCalls: 0 })
  })
})

test.each(['failed-message', 'unknown-message'])('batch stops after %s with one send and no retry', async id => {
  await withMail(async run => {
    const ids = `${id},later-message`
    const result = await run(['mail', 'message', 'trash', '--mailbox', 'mailbox@contoso.example', '--ids', ids,
      '--execute', '--confirm', ids])
    expect(result).toMatchObject({ complete: false, fakeSends: 1,
      results: [{ id, status: id === 'failed-message' ? 'failed' : 'unknown' }, { id: 'later-message', status: 'not-attempted' }] })
  })
})

test.each(['forwardTo', 'forwardAsAttachmentTo', 'redirectTo', 'permanentDelete'])('rule %s is refused before native credentials', async action => {
  await withMail(async run => {
    const value = action === 'permanentDelete' ? true : [{ emailAddress: { address: 'outside@contoso.example' } }]
    const text = JSON.stringify({ ...JSON.parse(rule), actions: { [action]: value } })
    expect(await run(['mail', 'rule', 'create', '--mailbox', 'mailbox@contoso.example', '--file', 'rule.json'], upload(text)))
      .toMatchObject({ error: { code: 'VALIDATION_ERROR' }, fakeSends: 0, credentialCalls: 0 })
  })
})

test('tagging an already present category is a no-op', async () => {
  await withMail(async run => {
    expect(await run(['mail', 'message', 'tag', '--mailbox', 'mailbox@contoso.example', '--ids', 'synthetic-message',
      '--add', 'Existing', '--execute', '--confirm', 'synthetic-message']))
      .toMatchObject({ complete: true, fakeSends: 0, results: [{ status: 'noop' }] })
  })
})

test.each([
  { args: ['--file', '/etc/rule.json'], input: upload() },
  { args: ['--file', 'rule.json'], input: {} },
  { args: ['--file', 'rule.json'], input: upload('x'.repeat(65537)) },
  { args: ['--file', 'rule.json'], input: upload('\u0000') },
  { args: ['--file', 'rule.json'], input: { files: [...upload().files!, { name: 'extra.json', contentBase64: 'e30=' }] } },
])('rule uploads reject unsupported transport before credentials: $args', async ({ args, input }) => {
  const getCredential = vi.fn()
  const adapter = createMgAdapter({ getCredential }, '/tmp/synthetic.log', profile())
  await expect(adapter.prepare(['mail', 'rule', 'create', '--mailbox', 'mailbox@contoso.example', ...args], reference, input))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})
