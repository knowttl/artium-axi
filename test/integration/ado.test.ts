import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { decode } from '@toon-format/toon'
import inventory from '../../tools/inventories/ado-axi.json' with { type: 'json' }
import { loginResponseSchema } from '../../src/shared/api.js'
import { createApp } from '../../src/server/app.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { ADO_API_BODY_MAX_BYTES } from '../../src/server/adapters/ado-api.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import type { PreparedCall } from '../../src/server/adapters/types.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'

// Exercise the shipped stand-in from the checkout without requiring an image install.
vi.mock('../../src/server/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/server/config.js')>(), adoPathPrefix: join(process.cwd(), 'libexec/ado-axi'),
}))

async function runPinned(runner: Runner, port: number, call: PreparedCall) {
  return runner.run('synthetic-user', process.execPath, [
    '--import', fileURLToPath(new URL('../fake-service/ado-transport.mjs', import.meta.url)),
    fileURLToPath(new URL('../../tools/node_modules/@knowttl/ado-axi/dist/bin/ado-axi.js', import.meta.url)), ...call.args,
  ], { ...call.environment, ARTIUM_TEST_ADO_ORIGIN: `https://localhost:${port}` }, call.secrets, call.limits, {}, call.files, undefined, call.pathPrefix)
}

test('established routes, aliases and defaults dispatch through the pinned binary', async () => {
  const org = '/synthetic-org'
  const project = `${org}/Synthetic%20Project`
  const git = `${project}/_apis/git/repositories/Synthetic%20Repo`
  const pr = `${git}/pullrequests/42`
  const wi = `${org}/_apis/wit/workitems/42`
  const reviewer = '11111111-1111-1111-1111-111111111111'
  const added = '22222222-2222-2222-2222-222222222222'
  const repo = ['--repo', 'Synthetic Repo']
  const routes: { command: string, values: string[], method: string, path: string, result: object,
    body?: unknown, query?: Record<string, string>, recovery?: unknown }[] = [
    { command: 'home', values: [], method: 'POST', path: `${org}/_apis/wit/workitemsbatch`,
      result: { 'my-work-items': [{ id: 42 }], 'active-pull-requests': [{ id: 42 }], 'recent-runs': [{ id: 8 }] } },
    { command: 'doctor', values: [], method: 'GET', path: `${org}/_apis/connectionData`,
      result: { status: 'all profiles authenticated', profiles: [{ status: 'ok', identity: 'Synthetic User' }] } },
    { command: 'work-item list', values: [], method: 'POST', path: `${project}/_apis/wit/wiql`,
      result: { 'work-items': [{ id: 42, title: 'Synthetic work item' }] } },
    { command: 'work-item get', values: ['42'], method: 'GET', path: wi,
      result: { 'work-item': { id: 42, description: 'Synthetic description' } } },
    { command: 'work-item create', values: ['--type', 'Task', '--title', 'Synthetic created item'], method: 'POST',
      path: `${project}/_apis/wit/workitems/$Task`, body: [{ op: 'add', path: '/fields/System.Title', value: 'Synthetic created item' }],
      result: { created: { id: 43, title: 'Synthetic created item' } }, recovery: { 'work-items': [{ id: 43, title: 'Synthetic created item' }] } },
    { command: 'work-item update', values: ['42', '--title', 'Synthetic updated item'], method: 'PATCH', path: wi,
      body: [{ op: 'add', path: '/fields/System.Title', value: 'Synthetic updated item' }],
      result: { updated: { id: 42, title: 'Synthetic updated item' } }, recovery: { response: { fields: { 'System.Title': 'Synthetic updated item' } } } },
    { command: 'work-item comment', values: ['42', '--body', 'Synthetic comment'], method: 'POST',
      path: `${project}/_apis/wit/workItems/42/comments`, body: { text: 'Synthetic comment' },
      result: { comment: { id: 1, posted: true } }, recovery: { response: { comments: [{ text: 'Synthetic comment' }] } } },
    { command: 'work-item link list', values: ['42'], method: 'GET', path: wi,
      result: { links: [{ target: 41, type: 'parent' }] } },
    { command: 'work-item link add', values: ['42', '--related', '43'], method: 'PATCH', path: `${project}/_apis/wit/workitems/42`,
      body: [{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related',
        url: 'https://dev.azure.com/synthetic-org/_apis/wit/workItems/43', attributes: {} } }],
      result: { linked: { target: '43', type: 'related' } },
      recovery: { response: { relations: expect.arrayContaining([expect.objectContaining({ rel: 'System.LinkTypes.Related' })]) } } },
    { command: 'pr list', values: [], method: 'GET', path: `${project}/_apis/git/pullrequests`,
      result: { 'pull-requests': [{ id: 42, title: 'Synthetic PR' }] } },
    { command: 'pr get', values: ['42'], method: 'GET', path: `${project}/_apis/git/pullrequests/42`,
      result: { 'pull-request': { id: 42, title: 'Synthetic PR' } } },
    { command: 'pr create', values: [...repo, '--source', 'feature', '--title', 'Synthetic created PR'], method: 'POST', path: `${git}/pullrequests`,
      body: { title: 'Synthetic created PR', sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main' },
      result: { created: { id: 43, title: 'Synthetic created PR' } }, recovery: { 'pull-requests': [{ id: 43, title: 'Synthetic created PR' }] } },
    { command: 'pr update', values: ['42', '--title', 'Synthetic updated PR'], method: 'PATCH', path: pr,
      body: { title: 'Synthetic updated PR' }, result: { updated: { title: 'Synthetic updated PR' } },
      recovery: { response: { title: 'Synthetic updated PR' } } },
    { command: 'pr complete', values: ['42'], method: 'PATCH', path: pr,
      body: { status: 'completed', lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
        completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false, bypassPolicy: false } },
      result: { completion: { id: 42, outcome: 'completed' } }, recovery: { response: { status: 'completed' } } },
    { command: 'pr abandon', values: ['42'], method: 'PATCH', path: pr, body: { status: 'abandoned' },
      result: { abandoned: { id: 42 } }, recovery: { response: { status: 'abandoned' } } },
    { command: 'pr checks', values: ['42'], method: 'GET', path: `${pr}/statuses`,
      result: { actionable: [{ name: 'Synthetic check', result: 'pending' }] } },
    { command: 'pr diff', values: ['42'], method: 'GET', path: `${pr}/iterations/1/changes`,
      result: { changes: [{ path: '/synthetic.txt', change: 'edit' }] } },
    { command: 'pr reviewers', values: ['42'], method: 'GET', path: `${pr}/reviewers`,
      result: { reviewers: [{ id: reviewer, name: 'Synthetic Reviewer' }] } },
    { command: 'pr reviewer list', values: ['42'], method: 'GET', path: `${pr}/reviewers`,
      result: { reviewers: [{ id: reviewer, name: 'Synthetic Reviewer' }] } },
    { command: 'pr reviewer add', values: ['42', '--reviewer', added], method: 'PUT', path: `${pr}/reviewers/${added}`,
      body: { vote: 0, isRequired: false }, result: { reviewer: { id: added, added: true } },
      recovery: { response: { reviewers: expect.arrayContaining([expect.objectContaining({ id: added })]) } } },
    { command: 'pr reviewer remove', values: ['42', '--reviewer', reviewer], method: 'DELETE', path: `${pr}/reviewers/${reviewer}`,
      result: { reviewer: { id: reviewer, removed: true } }, recovery: { response: { reviewers: [] } } },
    { command: 'pr approve', values: ['42'], method: 'PUT', path: `${pr}/reviewers/synthetic-user`, body: { vote: 10 },
      result: { vote: { result: 'approved' } },
      recovery: { response: { reviewers: expect.arrayContaining([expect.objectContaining({ id: 'synthetic-user', vote: 10 })]) } } },
    { command: 'pr comment', values: ['42', '--body', 'Synthetic PR comment'], method: 'POST', path: `${pr}/threads`,
      body: { comments: [{ parentCommentId: 0, content: 'Synthetic PR comment', commentType: 'text' }], status: 'active' },
      result: { comment: { thread: 5, posted: true } }, recovery: { threads: [{ comments: expect.stringContaining('Synthetic PR comment') }] } },
    { command: 'pr thread list', values: ['42'], method: 'GET', path: `${pr}/threads`,
      result: { threads: [{ id: 5, last: expect.stringContaining('Synthetic discussion') }] } },
    { command: 'pr thread resolve', values: ['42', '--thread', '5', '--status', 'closed'], method: 'PATCH', path: `${pr}/threads/5`,
      body: { status: 'closed' }, result: { thread: { id: 5, status: 'closed' } }, recovery: { threads: [{ id: 5, status: 'closed' }] } },
    { command: 'pr thread reopen', values: ['42', '--thread', '5'], method: 'PATCH', path: `${pr}/threads/5`,
      body: { status: 'active' }, result: { thread: { id: 5, status: 'active' } }, recovery: { threads: [{ id: 5, status: 'active' }] } },
    { command: 'pr thread reply', values: ['42', '--thread', '5', '--body', 'Synthetic reply'], method: 'POST', path: `${pr}/threads/5/comments`,
      body: { content: 'Synthetic reply', commentType: 'text' }, result: { reply: { thread: 5, posted: true } },
      recovery: { threads: [{ comments: expect.stringContaining('Synthetic reply') }] } },
    { command: 'pipeline list', values: [], method: 'GET', path: `${project}/_apis/pipelines`,
      result: { pipelines: [{ id: 7, name: 'Synthetic pipeline' }] } },
    { command: 'pipeline runs', values: [], method: 'GET', path: `${project}/_apis/build/builds`,
      result: { runs: [{ id: 8, pipeline: 'Synthetic pipeline' }] } },
    { command: 'pipeline run', values: ['--pipeline', '7', '--branch', 'main'], method: 'POST', path: `${project}/_apis/pipelines/7/runs`,
      body: { resources: { repositories: { self: { refName: 'refs/heads/main' } } } }, result: { queued: { run: 10, pipeline: '7' } },
      recovery: { runs: [{ id: 10, branch: 'main', status: 'inProgress' }] } },
    { command: 'pipeline logs', values: ['8'], method: 'GET', path: `${project}/_apis/build/builds/8/logs/1`,
      result: { content: 'Synthetic build log' } },
    { command: 'pipeline timeline', values: ['8'], method: 'GET', path: `${project}/_apis/build/builds/8/timeline`,
      result: { jobs: [{ name: 'Synthetic job', result: 'succeeded' }] } },
    { command: 'pipeline watch', values: ['8', '--timeout', '1'], method: 'GET', path: `${project}/_apis/build/builds/8`,
      result: { run: { id: 8, outcome: 'success', polls: 1 } } },
    { command: 'test results', values: ['8'], method: 'GET', path: `${project}/_apis/test/Runs/9/results`,
      result: { failures: [{ test: 'Synthetic test case', outcome: 'Failed' }] } },
    { command: 'repo list', values: [], method: 'GET', path: `${project}/_apis/git/repositories`,
      result: { repos: [{ name: 'Synthetic Repo', default: 'main' }] } },
    { command: 'repo branches', values: repo, method: 'GET', path: `${git}/refs`,
      result: { branches: [{ name: 'main' }, { name: 'feature-existing' }] } },
    { command: 'repo file', values: ['/synthetic.txt', ...repo], method: 'GET', path: `${git}/items`, query: { path: '/synthetic.txt' },
      result: { content: 'Synthetic file content' } },
    { command: 'ref list', values: repo, method: 'GET', path: `${git}/refs`,
      result: { refs: [{ name: 'main' }, { name: 'feature-existing' }] } },
    { command: 'ref create', values: [...repo, '--name', 'feature-new', '--source-object-id', 'a'.repeat(40)], method: 'POST', path: `${git}/refs`,
      body: [{ name: 'refs/heads/feature-new', oldObjectId: '0'.repeat(40), newObjectId: 'a'.repeat(40) }],
      result: { created: { name: 'feature-new', object: 'a'.repeat(40) } }, recovery: { refs: [{ name: 'feature-new', object: 'a'.repeat(40) }] } },
    { command: 'ref delete', values: [...repo, '--name', 'feature-existing'], method: 'POST', path: `${git}/refs`,
      body: [{ name: 'refs/heads/feature-existing', oldObjectId: 'b'.repeat(40), newObjectId: '0'.repeat(40) }],
      result: { deleted: { name: 'feature-existing' } }, recovery: { refs: '0 branch refs found in Synthetic Project/Synthetic Repo' } },
    { command: 'project list', values: [], method: 'GET', path: `${org}/_apis/projects`,
      result: { projects: [{ name: 'Synthetic Project' }] } },
    { command: 'api', values: ['_apis/projects', '--no-project'], method: 'GET', path: `${org}/_apis/projects`,
      result: { value: [{ id: 'synthetic-project', name: 'Synthetic Project' }] } },
  ]
  expect(inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
    .toEqual(expect.arrayContaining(routes.map(row => row.command)))
  const cases = routes.flatMap(row => {
    const route = inventory.commands.find(route => route.command === row.command)!
    const aliases = [...route.aliases, ...Object.entries(inventory.aliases)
      .filter(([, group]) => row.command.startsWith(`${group} `)).map(([alias]) => row.command.replace(/^\S+/, alias))]
    return [row, ...aliases.map(command => ({ ...row, command,
      ...(['pr comments', 'pr threads'].includes(command)
        ? { path: `${pr}/threads`, result: { threads: [{ comments: expect.stringContaining('Synthetic discussion') }] } } : {}) }))]
      .map(entry => ({ ...entry, effect: route.effect }))
  })
  const defaults = [
    ['home', ''], ['work-item list', 'work-item'], ['pr list', 'pr'], ['pipeline list', 'pipeline'],
    ['repo list', 'repo'], ['ref list', 'ref'], ['project list', 'project'], ['test results', 'test'],
    ['work-item link list', 'work-item link'], ['work-item link list', 'work-item links'], ['pr thread list', 'pr thread'],
  ].map(([canonical, command]) => ({ ...cases.find(row => row.command === canonical)!, command }))
  await withFakeService(async ({ directory, port, send }) => {
    const adapter = (allowWrites: boolean) => createAdoAdapter({ getCredential: async () => ({ org: 'synthetic-org',
      project: 'Synthetic Project', auth: 'pat', token: 'CANARY-ado-pat', allowWrites }) })
    const reference = { id: 'synthetic-ado', tool: 'ado-axi' as const, revision: 1 }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      for (const row of [...cases, ...defaults]) {
        await send('/__ado/reset', 'POST')
        const args = [...row.command.split(' ').filter(Boolean), ...row.values]
        if (row.effect === 'write') {
          await expect(adapter(false).prepare(args, reference), row.command).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
          expect(JSON.parse(await send('/__evidence')).requests, row.command).toEqual([])
        }
        const call = await adapter(true).prepare(args, reference)
        expect(call.effect, row.command).toBe(row.effect)
        const result = await runPinned(runner, port, call)
        expect(result.exitCode, `${row.command}: ${result.stdout}`).toBe(0)
        expect(decode(result.stdout), row.command).toMatchObject(row.result)
        const evidence = JSON.parse(await send('/__evidence'))
        expect(evidence.requests, row.command).toContainEqual(expect.objectContaining({
          method: row.method, path: row.path, auth: 'Basic', canaryReceived: true,
          ...(row.body ? { body: expect.objectContaining(row.body) } : {}),
          ...(row.query ? { query: expect.objectContaining(row.query) } : {}),
        }))
        expect(evidence.mutations > 0, row.command).toBe(row.effect === 'write')
        if (row.recovery) {
          const check = await adapter(false).prepare(call.write!.checkArgs, reference)
          expect(check.effect, row.command).toBe('read')
          const recovered = await runPinned(runner, port, check)
          expect(recovered.exitCode, `${row.command}: ${recovered.stdout}`).toBe(0)
          expect(decode(recovered.stdout), row.command).toMatchObject(row.recovery)
        }
      }
      await send('/__ado/reset', 'POST')
      for (const route of inventory.commands.filter(route => route.effect === 'blocked')) {
        await expect(adapter(true).prepare(route.command.split(' '), reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
      }
      for (const args of [['--help'], ['home', '--help'], ['--project', 'Other Project', '--help'],
        ['--help', '--project=Other Project'], ['--version'], ['-v'], ['pr', 'reviewer', '--help'], ['pr', 'update', '42', '--help']]) {
        const result = await runPinned(runner, port, await adapter(false).prepare(args, reference))
        expect(result.exitCode, result.stdout).toBe(0)
        expect(result.stdout).toContain(args.includes('--help') ? 'ado-axi' : '0.5.0')
      }
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
    } finally { await runner.shutdown() }
  })
}, 180_000)

test('explicit text flag values reach the pinned binary unchanged', async () => {
  const text = '---\nSummary\r\nValue=kept\u2028Final paragraph'
  const org = '/synthetic-org'
  const project = `${org}/Synthetic%20Project`
  const pr = `${project}/_apis/git/repositories/Synthetic%20Repo/pullrequests`
  const descriptionPatch = expect.arrayContaining([{ op: 'add', path: '/fields/System.Description', value: text }])
  const rows = [
    { args: ['work-item', 'create', '--type', 'Task', '--title', 'Synthetic item'], flag: 'description', text,
      method: 'POST', path: `${project}/_apis/wit/workitems/$Task`, body: descriptionPatch },
    { args: ['work-item', 'update', '42'], flag: 'description', text,
      method: 'PATCH', path: `${org}/_apis/wit/workitems/42`, body: descriptionPatch },
    { args: ['work-item', 'comment', '42'], flag: 'body', text,
      method: 'POST', path: `${project}/_apis/wit/workItems/42/comments`, body: { text } },
    { args: ['pr', 'create', '--repo', 'Synthetic Repo', '--source', 'feature', '--title', 'Synthetic PR'], flag: 'description', text,
      method: 'POST', path: pr, body: expect.objectContaining({ description: text }) },
    { args: ['pr', 'update', '42'], flag: 'description', text,
      method: 'PATCH', path: `${pr}/42`, body: { description: text } },
    { args: ['pr', 'comment', '42'], flag: 'body', text,
      method: 'POST', path: `${pr}/42/threads`, body: expect.objectContaining({ comments: [{ parentCommentId: 0, content: text, commentType: 'text' }] }) },
    { args: ['pr', 'thread', 'reply', '42', '--thread', '5'], flag: 'body', text,
      method: 'POST', path: `${pr}/42/threads/5/comments`, body: { content: text, commentType: 'text' } },
    { args: ['pr', 'update', '42'], flag: 'title', text: '--help',
      method: 'PATCH', path: `${pr}/42`, body: { title: '--help' } },
    { args: ['work-item', 'update', '42'], flag: 'title', text: 'First line\nSecond line',
      method: 'PATCH', path: `${org}/_apis/wit/workitems/42`,
      body: [{ op: 'add', path: '/fields/System.Title', value: 'First line\nSecond line' }] },
    { args: ['pr', 'update', '42'], flag: 'description', text: '--title=literal',
      method: 'PATCH', path: `${pr}/42`, body: { description: '--title=literal' } },
  ]
  await withFakeService(async ({ directory, port, send }) => {
    const adapter = createAdoAdapter({ getCredential: async () => ({ org: 'synthetic-org', project: 'Synthetic Project',
      auth: 'pat', token: 'CANARY-ado-pat', allowWrites: true }) })
    const reference = { id: 'synthetic-ado', tool: 'ado-axi' as const, revision: 1 }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      for (const row of rows) {
        for (const flags of [[`--${row.flag}`, row.text], [`--${row.flag}=${row.text}`]]) {
          await send('/__ado/reset', 'POST')
          const args = [...row.args, ...flags]
          const call = await adapter.prepare(args, reference)
          const result = await runPinned(runner, port, call)
          expect(result.exitCode, `${JSON.stringify(args)}: ${result.stdout}`).toBe(0)
          expect(JSON.parse(await send('/__evidence')).requests, JSON.stringify(args)).toContainEqual(expect.objectContaining({
            method: row.method, path: row.path, body: row.body,
          }))
        }
      }
    } finally { await runner.shutdown() }
  })
}, 60_000)

test.each([
  { args: ['pr', 'update', '42', '--description', ''], expected: { description: '' } },
  { args: ['work-item', 'update', '42', '--tags', ''], expected: { fields: { 'System.Tags': '' } } },
  { args: ['work-item', 'update', '42', '--description='], expected: { fields: { 'System.Description': '' } } },
  { args: ['wi', 'update', '42', '--assigned-to', ''], expected: { fields: { 'System.AssignedTo': '' } } },
  { args: ['work-item', 'update', '42', '--set', '{"Custom.Value":"changed"}'], expected: { fields: { 'Custom.Value': 'changed' } } },
  { args: ['pr', 'update', '42', '--auto-complete'], expected: { autoCompleteSetBy: { id: 'synthetic-user' } } },
])('the pinned binary recovery read exposes the updated state for $args', async ({ args, expected }) => {
  await withFakeService(async ({ directory, port }) => {
    const adapter = createAdoAdapter({ getCredential: async () => ({ org: 'synthetic-org', project: 'Synthetic Project',
      auth: 'pat', token: 'CANARY-ado-pat', allowWrites: true }) })
    const reference = { id: 'synthetic-ado', tool: 'ado-axi' as const, revision: 1 }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      const call = await adapter.prepare(args, reference)
      expect(await runPinned(runner, port, call)).toMatchObject({ exitCode: 0 })
      const check = await adapter.prepare(call.write!.checkArgs, reference)
      const result = await runPinned(runner, port, check)
      expect(result.exitCode, result.stdout).toBe(0)
      expect(decode(result.stdout)).toMatchObject({ response: expected })
    } finally { await runner.shutdown() }
  })
})

test('the pinned binary recovery read includes the full posted thread reply', async () => {
  await withFakeService(async ({ directory, port }) => {
    const adapter = createAdoAdapter({ getCredential: async () => ({ org: 'synthetic-org', project: 'Synthetic Project',
      auth: 'pat', token: 'CANARY-ado-pat', allowWrites: true }) })
    const reference = { id: 'synthetic-ado', tool: 'ado-axi' as const, revision: 1 }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const body = 'Synthetic reply '.repeat(100) + 'complete reply marker'
    try {
      const call = await adapter.prepare(['pr', 'thread', 'reply', '42', '--thread', '5', '--body', body], reference)
      expect(await runPinned(runner, port, call)).toMatchObject({ exitCode: 0 })
      const result = await runPinned(runner, port, await adapter.prepare(call.write!.checkArgs, reference))
      expect(result.exitCode, result.stdout).toBe(0)
      expect(result.stdout).toContain(body)
    } finally { await runner.shutdown() }
  })
})

test.each([
  { value: { auth: 'pat', token: 'CANARY-ado-pat' }, header: 'Basic', secret: 'CANARY-ado-pat' },
  { value: { auth: 'client-secret', tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222',
    clientSecret: 'CANARY-ado-client-secret' }, header: 'Bearer', secret: 'CANARY-AZURE-ACCESS-TOKEN' },
])('managed $value.auth credentials can be saved, tested and used with write gating through the pinned binary', async ({ value, header, secret }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const network = new FakeTokenTransport()
    const adapter = createAdoAdapter(new EmbeddedSecretSource(store), new AzureTokenCache(network))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', fileURLToPath(new URL('../fake-service/ado-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/ado-axi/dist/bin/ado-axi.js', import.meta.url)), ...call.args],
        environment: { ...call.environment, ARTIUM_TEST_ADO_ORIGIN: `https://localhost:${port}` } }
    }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi/credential', headers,
        payload: { value: { org: 'https://dev.azure.com/synthetic-org/', project: 'Synthetic Project', ...value },
          expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.json()).toMatchObject({ metadata: { org: 'synthetic-org', auth: value.auth }, normalizations: [{ field: 'org' }] })
      expect(saved.body).not.toContain('CANARY-')
      const checked = await app.inject({ method: 'POST', url: '/v1/admin/tools/ado-axi/test', headers, payload: {} })
      expect(checked.statusCode, checked.body).toBe(200)
      expect(checked.json()).toMatchObject({ status: 'ok', readOnly: true })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        host: 'dev.azure.com', path: '/synthetic-org/_apis/projects', auth: header, canaryReceived: true,
      }))
      const enabled = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi', headers,
        payload: { enabled: true, expectedRevision: 2 } })
      expect(enabled.statusCode, enabled.body).toBe(200)
      const run = (args: string[], input = {}) => app.inject({ method: 'POST', url: '/v1/tools/ado-axi/run', headers, payload: { args, ...input } })
      await send('/__ado/reset', 'POST')
      for (const flag of ['org', 'profile', 'config']) {
        for (const args of [[`--${flag}`, 'other', 'project', 'list'], ['project', 'list', `--${flag}=other`]]) {
          expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
        }
      }
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      const result = await run(['projects', 'list', '--limit', '1'])
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic Project') })
      const query = await run(['wi', 'list', '--limit', '1'])
      expect(query.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic work item') })
      const write = ['work-item', 'update', '42', '--title', 'Synthetic changed title']
      expect((await run(write)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const patchBody = '[{"op":"add","path":"/fields/System.Title","value":"Synthetic raw TD-067"}]'
      const rawBody = patchBody.padEnd(ADO_API_BODY_MAX_BYTES)
      const rawPath = '_apis/wit/workitems/42'
      vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', JSON.stringify({ PATCH: ['_apis/wit/workitems/*'] }))
      const rawWrite = ['api', rawPath, '-X', 'PATCH', '--content-type', 'json-patch', '--body', rawBody, '--no-project']
      expect((await run(rawWrite)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const switched = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi', headers,
        payload: { nativeSettings: { allowWrites: true }, expectedRevision: 3 } })
      expect(switched.statusCode, switched.body).toBe(200)
      const written = await run(write)
      expect(written.statusCode, written.body).toBe(200)
      expect(written.json()).toMatchObject({ exitCode: 0 })
      expect((await run(['api', 'POST', '_apis/projects'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run(['api', '_apis/projects'], { stdin: '{}' })).json()).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT' } })
      const redacted = await run(['api', '_apis/redaction'])
      expect(redacted.json()).toMatchObject({ error: { code: 'SECRET_IN_OUTPUT' } })
      expect(redacted.body).not.toContain(secret)
      expect(redacted.body).not.toContain(Buffer.from(':CANARY-ado-pat').toString('base64'))
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/synthetic-org/_apis/projects', auth: header, canaryReceived: true }),
        expect.objectContaining({ method: 'POST', path: '/synthetic-org/Synthetic%20Project/_apis/wit/wiql', auth: header, canaryReceived: true }),
        expect.objectContaining({ method: 'PATCH', path: '/synthetic-org/_apis/wit/workitems/42', auth: header, canaryReceived: true,
          body: [{ op: 'add', path: '/fields/System.Title', value: 'Synthetic changed title' }] }),
      ]))
      const audit = db.prepare("SELECT action, arguments FROM audit WHERE tool = 'ado-axi' AND event = 'run-terminal'").all()
      expect(audit).toContainEqual(expect.objectContaining({ action: 'write' }))
      expect(audit).toContainEqual(expect.objectContaining({ action: 'read' }))
      expect(JSON.stringify(audit)).not.toContain(secret)
      expect(JSON.stringify(audit)).not.toContain(Buffer.from(':CANARY-ado-pat').toString('base64'))
      // TD-067: exercise the real HTTP policy, credential, runner and pinned API command.
      await send('/__ado/reset', 'POST')
      for (const path of ['_apis/wit/workitems/43/other', '../_apis/wit/workitems/42',
        '_apis/%2e%2e/wit/workitems/42', '_apis/%252e%252e/wit/workitems/42',
        '_apis/wit/../workitems/42', '_apis/wit/./workitems/42', '_apis/wit%2fworkitems/42',
        '_apis/wit%5cworkitems/42', '_apis/wit/workitems/%zz',
        'https://dev.azure.com/other/_apis/wit/workitems/42', '//other/_apis/wit/workitems/42',
        '_apis/wit/workitems/42?other=1', '_apis/wit/workitems/42%3fother=1']) {
        expect((await run(['api', path, '--method=PATCH', '--body', rawBody])).json())
          .toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      }
      for (const extra of [['--host', 'dev'], ['--query', 'other=1']]) {
        expect((await run([...rawWrite, ...extra])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      }
      for (const body of ['{invalid', JSON.stringify('x'.repeat(ADO_API_BODY_MAX_BYTES))]) {
        expect((await run(['api', rawPath, '--method', 'PATCH', '--body', body])).json())
          .toMatchObject({ error: { code: 'INVALID_INPUT' } })
      }
      for (const configuration of [undefined, '{}', '{invalid', '[]']) {
        vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', configuration)
        expect((await run(rawWrite)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      }
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', JSON.stringify({ PATCH: ['_apis/wit/workitems/*'] }))
      expect((await run(rawWrite)).json()).toMatchObject({ exitCode: 0 })
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([
        expect.objectContaining({ method: 'PATCH', path: '/synthetic-org/_apis/wit/workitems/42', body: JSON.parse(rawBody) }),
      ])
      const journal = db.prepare("SELECT user_id, outcome, arguments FROM audit WHERE event = 'ado-api' ORDER BY id").all() as
        { user_id: string, outcome: string, arguments: string }[]
      expect(journal).toContainEqual({ user_id: 'synthetic-development-user', outcome: 'refused', arguments: JSON.stringify({
        method: 'PATCH', path: rawPath, decision: 'refused', bodySha256: createHash('sha256').update(rawBody).digest('hex'), bodyBytes: Buffer.byteLength(rawBody),
      }) })
      expect(journal.at(-1)).toEqual({ user_id: 'synthetic-development-user', outcome: 'allowed', arguments: JSON.stringify({
        method: 'PATCH', path: rawPath, decision: 'allowed', bodySha256: createHash('sha256').update(rawBody).digest('hex'), bodyBytes: Buffer.byteLength(rawBody),
      }) })
      expect(journal.map(row => JSON.parse(row.arguments))).toContainEqual(expect.objectContaining({ path: null, decision: 'refused' }))
      expect(journal.map(row => JSON.parse(row.arguments))).toContainEqual(expect.objectContaining({
        decision: 'refused', bodyBytes: ADO_API_BODY_MAX_BYTES + 2,
        bodySha256: createHash('sha256').update(JSON.stringify('x'.repeat(ADO_API_BODY_MAX_BYTES))).digest('hex'),
      }))
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('Synthetic raw TD-067')
      for (const row of [
        { method: 'POST', path: '_apis/wit/workItems/42/comments', body: { text: 'Synthetic raw comment' } },
        { method: 'PUT', path: '_apis/git/repositories/Synthetic%20Repo/pullrequests/42/reviewers/11111111-1111-4111-8111-111111111111', body: { vote: 10 } },
        { method: 'DELETE', path: '_apis/git/repositories/Synthetic%20Repo/pullrequests/42/reviewers/11111111-1111-4111-8111-111111111111', body: {} },
      ]) {
        await send('/__ado/reset', 'POST')
        vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', JSON.stringify({ [row.method]: [row.path] }))
        const response = await run(['api', row.path, '--method', row.method, '--body', JSON.stringify(row.body)])
        expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
        expect(JSON.parse(await send('/__evidence')).requests).toEqual([
          expect.objectContaining({ method: row.method, path: `/synthetic-org/Synthetic%20Project/${row.path}`, body: row.body }),
        ])
      }
      await send('/__ado/reset', 'POST')
      db.prepare("DELETE FROM role_tools WHERE tool = 'ado-axi'").run()
      expect((await run(rawWrite)).json()).toMatchObject({ error: { code: 'TOOL_NOT_GRANTED' } })
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'ado-api' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ user_id: 'synthetic-development-user', outcome: 'refused' })
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
      // Enabling writes replaces the credential revision and invalidates its token.
      expect(network.requests).toHaveLength(value.auth === 'pat' ? 0 : 2)
      if (value.auth === 'client-secret') {
        expect(network.requests.map(request => request.form.get('scope'))).toEqual(Array(2).fill('499b84ac-1321-427f-aa17-267ca6975798/.default'))
      }
    } finally { vi.unstubAllEnvs(); await app.close(); db.close() }
  })
})
