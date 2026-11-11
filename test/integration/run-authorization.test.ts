import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { createBeyondtrustAdapter } from '../../src/server/adapters/beyondtrust.js'
import { createCheckpointAdapter } from '../../src/server/adapters/checkpoint.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createGhAdapter } from '../../src/server/adapters/gh.js'
import { createGiteaAdapter } from '../../src/server/adapters/gitea.js'
import { createHybridAdapter } from '../../src/server/adapters/hybrid.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createTechnitiumAdapter } from '../../src/server/adapters/technitium.js'
import { createTenableAdapter } from '../../src/server/adapters/tenable.js'
import type { Adapter } from '../../src/server/adapters/types.js'
import { createUnifiAdapter } from '../../src/server/adapters/unifi.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { runTool } from '../../src/server/runner/run.js'
import { Runner } from '../../src/server/runner/runner.js'
import type { ToolName } from '../../src/server/store/credential-store.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { azureTestTenant, FakeTokenTransport } from '../fixtures/azure-token-transport.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const mgProfile = join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json')
const credentials = {
  'hybrid-axi': { apiKey: 'CANARY-hybrid-key' },
  'checkpoint-axi': { region: 'ca', clientId: 'synthetic-client', clientSecret: 'CANARY-checkpoint-secret' },
  'beyondtrust-axi': { host: 'example.pm.beyondtrustcloud.com', clientId: 'synthetic-client', clientSecret: 'CANARY-beyondtrust-secret' },
  'tenable-axi': { accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-secret' },
  'vectra-axi': { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra-token', origin: 'https://appliance.test' },
  'mg-axi': { mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret', enabledPacks: ['entra', 'mail'],
    tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' },
  'gh-axi': { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' },
  'az-axi': { auth: 'secret', tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret' },
  'ado-axi': { org: 'synthetic-org', project: 'Synthetic Project', auth: 'pat', token: 'CANARY-ado-pat' },
  'awx-axi': { origin: 'https://controller.example', token: 'CANARY-awx-token' },
  'unifi-axi': { origin: 'https://synthetic.invalid', apiKey: 'CANARY-unifi-key' },
  'technitium-axi': { origin: 'https://synthetic.invalid', auth: 'token', tokenKind: 'api', token: 'CANARY-technitium-token' },
  'gitea-axi': { origin: 'https://gitea.synthetic.invalid', tokenOrigin: 'https://gitea.synthetic.invalid', token: 'CANARY-gitea-token' },
} as const
type AdapterTool = keyof typeof credentials

const adapters: Record<AdapterTool, (source: EmbeddedSecretSource, writeLog: string) => Adapter<unknown>> = {
  'hybrid-axi': createHybridAdapter,
  'checkpoint-axi': createCheckpointAdapter,
  'beyondtrust-axi': createBeyondtrustAdapter,
  'tenable-axi': createTenableAdapter,
  'vectra-axi': createVectraAdapter,
  'mg-axi': (source, writeLog) => createMgAdapter(source, writeLog, loadCredentialProfile('mg-axi', mgProfile)!),
  'gh-axi': source => createGhAdapter(source),
  'az-axi': (source, writeLog) => createAzAdapter(source, writeLog, new AzureTokenCache(new FakeTokenTransport())),
  'ado-axi': source => createAdoAdapter(source),
  'awx-axi': source => createAwxAdapter(source),
  'unifi-axi': createUnifiAdapter,
  'technitium-axi': createTechnitiumAdapter,
  'gitea-axi': createGiteaAdapter,
}

const nativeResult = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, outputBytes: { stdout: 0, stderr: 0 },
  timedOut: false, truncated: { stdout: false, stderr: false } }
const context = { requestId: 'synthetic-run', clientAddress: '192.0.2.1' }

let directory: string
let db: ReturnType<typeof openStore>
let audit: Audit
let runner: Runner
let token: string
let resolver: SharedIdentityResolver
let source: EmbeddedSecretSource

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-run-authorization-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  for (const [tool, value] of Object.entries(credentials)) {
    store.replaceCredential(tool as ToolName, value, 0, 'synthetic-development-user', Date.now())
    db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  }
  source = new EmbeddedSecretSource(store)
  resolver = new SharedIdentityResolver(store, db)
  audit = new Audit(db, Date.now, () => {})
  runner = await Runner.create(join(directory, 'calls'))
  token = issueTestAccessToken(db, 'synthetic-development-user')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await runner.shutdown()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const grantWrites = (tool: AdapterTool, operations: string[]) => db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?')
  .run(JSON.stringify({ writes: { allowWrites: true, operations }, ...tool === 'mg-axi' ? { enabledPacks: ['entra', 'mail'] } : {} }), tool)
let requests = 0
const run = (tool: AdapterTool, args: readonly string[]) => runTool(db, audit, runner, token, { args: [...args] },
  adapters[tool](source, join(directory, 'writes.log')), resolver, { ...context, requestId: `synthetic-run-${requests++}` })

test.each([
  { tool: 'hybrid-axi', operation: 'submitUrl', other: 'yaraCreate',
    args: ['submit', 'url', '--url', 'https://example.com/synthetic', '--environment-id', '160', '--execute', '--confirm', 'synthetic'] },
  { tool: 'checkpoint-axi', operation: 'email.quarantine', other: 'email.restore',
    args: ['email', 'quarantine', '--ids', 'synthetic', '--execute', '--confirm', 'email.quarantine synthetic'] },
  { tool: 'checkpoint-axi', operation: 'event.action.dismiss', other: 'event.action.restore',
    args: ['event', 'action', '--ids', 'synthetic', '--name', 'dismiss', '--execute', '--confirm', 'event.action.dismiss synthetic'] },
  { tool: 'beyondtrust-axi', operation: 'computer.archive', other: 'computer.unarchive',
    args: ['computer', 'archive', 'synthetic', '--execute', '--confirm', 'synthetic'] },
  { tool: 'tenable-axi', operation: 'tags-delete-tag-value', other: 'tags-create-tag-value',
    args: ['tag', 'value', 'delete', '--id', '00000000-0000-0000-0000-000000000000', '--execute', '--confirm', 'synthetic'] },
  { tool: 'vectra-axi', operation: 'qux.detection.tag.set', other: 'qux.host.tag.set',
    args: ['detection', 'tag', 'set', '--id', '42', '--tags', 'synthetic', '--execute', '--confirm', 'detection 42'] },
  { tool: 'vectra-axi', operation: 'qux.detection.close', other: 'qux.detection.close-bulk',
    args: ['detection', 'close', '--id', '42', '--execute', '--confirm', 'detection 42'] },
  { tool: 'vectra-axi', operation: 'qux.account.assignment.unassign', other: 'qux.host.assignment.unassign',
    args: ['assignment', 'set', '--account', '7', '--unassign', '--execute', '--confirm', 'account 7'] },
  { tool: 'mg-axi', operation: 'mail.message.trash', other: 'mail.message.move',
    args: ['mail', 'message', 'trash', '--mailbox', 'mailbox@contoso.example', '--ids', 'synthetic', '--execute', '--confirm', 'synthetic'] },
] as const)('$tool sends an executing write to the native tool only when its operation is on the administrator allow-list', async ({ tool, operation, other, args }) => {
  const native = vi.spyOn(runner, 'run').mockResolvedValue(nativeResult)
  const credentialRead = vi.spyOn(source, 'getCredential')
  db.prepare("UPDATE tools SET native_settings = '{}' WHERE name = ?").run(tool)
  await expect(run(tool, args)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  grantWrites(tool, [other])
  await expect(run(tool, args)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(credentialRead).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'denial' AND tool = ?").all(tool))
    .toEqual([{ outcome: 'FLAG_BLOCKED' }, { outcome: 'FLAG_BLOCKED' }])
  grantWrites(tool, [operation])
  expect(await run(tool, args)).toMatchObject({ exitCode: 0 })
  expect(native).toHaveBeenCalledOnce()
})

const reads: Record<Exclude<AdapterTool, 'vectra-axi'>, { args: string[], settings: Record<string, unknown> }> = {
  'hybrid-axi': { args: ['quota'], settings: { writes: { allowWrites: true, operations: ['submitUrl'] } } },
  'checkpoint-axi': { args: ['email', 'search'], settings: { writes: { allowWrites: true, operations: ['email.quarantine'] } } },
  'beyondtrust-axi': { args: ['computer', 'list'], settings: { writes: { allowWrites: true, operations: ['computer.archive'] } } },
  'tenable-axi': { args: ['card', 'list', '--limit', '1'], settings: { writes: { allowWrites: true, operations: ['raw-write'] } } },
  'mg-axi': { args: ['entra', 'user', 'list'], settings: { writes: { allowWrites: true, operations: ['mail.message.trash'] }, enabledPacks: ['entra', 'mail'] } },
  'gh-axi': { args: ['issue', 'list', '-R', 'canary/repo'], settings: { writes: { allowWrites: true, operations: ['issue comment'] } } },
  'az-axi': { args: ['auth', 'status'], settings: { allowWrites: true } },
  'ado-axi': { args: ['work-item', 'list'], settings: { allowWrites: true } },
  'awx-axi': { args: ['job', 'list'], settings: { allowWrites: true } },
  'unifi-axi': { args: ['site', 'list'], settings: { writes: { allowWrites: true, operations: [] } } },
  'technitium-axi': { args: ['status'], settings: { hostWrites: { allowWrites: true, operations: [] } } },
  'gitea-axi': { args: ['repo', 'list'], settings: { writes: { allowWrites: true, operations: [] } } },
}

test.each(Object.keys(reads) as (keyof typeof reads)[])(
  '%s runs a read-only instance with the native read-only switch on although tool writes are enabled', async tool => {
    const native = vi.spyOn(runner, 'run').mockResolvedValue(nativeResult)
    const switchName = `${tool.toUpperCase().replaceAll('-', '_')}_READ_ONLY`
    db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?').run(JSON.stringify(reads[tool].settings), tool)
    await run(tool, reads[tool].args)
    expect(native.mock.calls[0][3][switchName]).not.toBe('true')
    db.prepare('UPDATE credentials SET read_only = 1 WHERE tool = ?').run(tool)
    await run(tool, reads[tool].args)
    expect(native.mock.calls[1][3][switchName]).toBe('true')
  })

test('vectra-axi refuses an executing write whose operation is selected only for the other deployment kind', async () => {
  const native = vi.spyOn(runner, 'run').mockResolvedValue(nativeResult)
  const args = ['detection', 'close', '--id', '42', '--execute', '--confirm', 'detection 42']
  grantWrites('vectra-axi', ['rux.detection.close'])
  await expect(run('vectra-axi', args)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(native).not.toHaveBeenCalled()
  grantWrites('vectra-axi', ['qux.detection.close'])
  expect(await run('vectra-axi', args)).toMatchObject({ exitCode: 0 })
  expect(native).toHaveBeenCalledOnce()
})
