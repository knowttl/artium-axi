import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { Runner } from '../../src/server/runner/runner.js'
import { withFakeService } from '../fake-service/fixture.js'

const credential = { mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
  tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' }
const reference = { id: 'synthetic-mail', tool: 'mg-axi' as const, revision: 1 }
const profile = () => loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
const reads = [
  { args: ['mail', 'folder', 'list'], output: 'Synthetic Inbox' },
  { args: ['mail', 'folder', 'show', '--id', 'inbox'], output: 'Synthetic Inbox' },
  { args: ['mail', 'message', 'list'], output: 'Synthetic Mail' },
  { args: ['mail', 'message', 'show', '--id', 'synthetic-message'], output: 'Outside sender content' },
  { args: ['mail', 'attachment', 'list', '--id', 'synthetic-message'], output: 'metadata.txt' },
  { args: ['mail', 'settings', 'show'], output: 'UTC' },
  { args: ['mail', 'rule', 'list'], output: 'Synthetic Rule' },
  { args: ['mail', 'rule', 'show', '--id', 'synthetic-rule'], output: 'Synthetic Rule' },
  { args: ['mail', 'category', 'list'], output: 'Synthetic Category' },
]

test.each(reads)('hosted $args reads use the published mail profile and fake Graph', async ({ args, output }) => {
  await withFakeService(async ({ directory }) => {
    const adapter = createMgAdapter({ getCredential: async () => ({ ...credential, enabledPacks: ['entra', 'mail'] }) },
      join(directory, 'writes.log'), profile())
    const call = await adapter.prepare([...args, '--mailbox', 'mailbox@contoso.example'], reference)
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const result = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args],
        call.environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain(output)
      expect(result.stdout).not.toContain('DO-NOT-PRINT')
    } finally { await runner.shutdown() }
  })
})

test.each(reads)('$args requires the administrator mail opt-in', async ({ args }) => {
  const adapter = createMgAdapter({ getCredential: async () => credential }, '/tmp/synthetic-writes.log', profile())
  await expect(adapter.prepare([...args, '--mailbox', 'mailbox@contoso.example'], reference))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each([
  ['mail', 'message', 'tag'], ['mail', 'message', 'send'], ['mail', 'message', 'reply'],
  ['mail', 'message', 'forward'], ['mail', 'message', 'permanentDelete'],
  ['mail', 'message', 'export'], ['mail', 'attachment', 'save'],
])('unavailable command %j refuses before credentials', async (...args) => {
  const getCredential = vi.fn()
  const adapter = createMgAdapter({ getCredential }, '/tmp/synthetic-writes.log', profile())
  await expect(adapter.prepare(args, reference)).rejects.toBeDefined()
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['search', 'filter', 'conversation'])('mail --%s values are sensitive audit arguments', flag => {
  const adapter = createMgAdapter({ getCredential: vi.fn() }, '/tmp/synthetic-writes.log', profile())
  expect(adapter.sensitiveArguments?.(['mail', 'message', 'list', `--${flag}`, 'synthetic-query']).flags)
    .toContain(`--${flag}`)
})
