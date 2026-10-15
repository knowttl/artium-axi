import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { errorResponseSchema, runSuccessSchema } from '../../src/shared/api.js'
import { decode, encode } from '@toon-format/toon'
import { rewriteSuggestions } from '../../src/cli/rewrite.js'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const subscription = '44444444-4444-4444-8444-444444444444'
const apiTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-api`
const nativeTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-native`
const readTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-read`
const incidentId = '11111111-1111-4111-8111-111111111111'
const incidentTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-recovery/providers/Microsoft.OperationalInsights/workspaces/synthetic workspace/providers/Microsoft.SecurityInsights/incidents/${incidentId}`

function hostedArgs(command: string): string[] {
  const tokens = command.match(/'[^']*'|[^\s]+/g)!.map(token => token.startsWith("'") ? token.slice(1, -1) : token)
  expect(tokens.slice(0, 2)).toEqual(['artium-axi', 'az-axi'])
  return tokens.slice(2)
}

async function withAzureGateway(check: (fixture: {
  run: (args: string[], input?: { stdin: string }) => Promise<{ statusCode: number, json(): unknown }>
  send: (path: string) => Promise<string>
  db: ReturnType<typeof openStore>
}) => Promise<void>, outcome: 'hold' | '504' | 'drop' = 'hold') {
  await withFakeService(async ({ directory, port, send }) => {
    const db = openStore(join(directory, 'artium.db'),
      new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
    const runner = await Runner.create(join(directory, 'calls'))
    const reference = { id: 'synthetic-azure', tool: 'az-axi' as const, revision: 1 }
    const adapter = createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
      subscriptions: [subscription], workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' },
      allowWrites: true }) }, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
    const hosted = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
      const call = await adapter.prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', fileURLToPath(new URL('../fake-service/azure-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', import.meta.url)), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 3), limits: { timeoutMs: 5000 },
        environment: { ...call.environment, NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt'),
          ARTIUM_TEST_AZURE_OUTCOME: outcome,
          ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}` } }
    } }
    const app = createApp({ db, audit: new Audit(db), runner, adapters: [hosted],
      resolver: { resolve: async () => reference }, environment: {} })
    try {
      await seedToolUser(db)
      db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'az-axi'")
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      await check({ db, send, run: async (args, input) => app.inject({ method: 'POST', url: '/v1/tools/az-axi/run',
        headers: { authorization: `Bearer ${token}` }, payload: { args, ...input } }) })
    } finally {
      await app.close()
      db.close()
    }
  })
}

test.each([{ flags: ['--execute=false'] }, { flags: ['--execute', 'false'] }])('Azure preview $flags is audited as a read', async ({ flags }) => {
  await withAzureGateway(async ({ run, send, db }) => {
    const response = await run(['api', 'PATCH', apiTarget, '--api-version', '2022-12-01',
      '--body', '{"tags":{"synthetic":"yes"}}', ...flags])
    expect(response.statusCode).toBe(200)
    expect(runSuccessSchema.parse(response.json()).exitCode).toBe(0)
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
    expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
  })
})

test('an Azure executed no-op is audited as a read', async () => {
  await withAzureGateway(async ({ run, send, db }) => {
    const args = ['api', 'PATCH', apiTarget, '--api-version', '2022-12-01',
      '--body', '{"tags":{"synthetic":"yes"}}', '--execute']
    expect((await run(args)).statusCode).toBe(504)
    const response = await run(args)
    expect(response.statusCode).toBe(200)
    expect(runSuccessSchema.parse(response.json()).exitCode).toBe(0)
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
    expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ action: 'read' })
  })
})

test.each([
  { name: 'API PATCH', args: ['api', 'PATCH', apiTarget, '--api-version', '2022-12-01', '--body', '{"tags":{"synthetic":"yes"}}', '--execute'],
    code: 'UNKNOWN_OUTCOME', path: apiTarget, mutations: 1, method: 'PATCH', operation: 'PATCH',
    guidance: `Check current state before trying again: artium-axi az-axi api GET ${apiTarget}`,
    check: ['api', 'GET', apiTarget, '--api-version', '2022-12-01', '--full'] },
  { name: 'native tag PATCH', args: ['tag', 'update', '--subscription', subscription, '--resource-id', nativeTarget,
    '--operation', 'merge', '--tags', 'synthetic=yes', '--execute'],
    code: 'UNKNOWN_OUTCOME', path: `${nativeTarget}/providers/Microsoft.Resources/tags/default`, mutations: 1, method: 'PATCH', operation: 'tag update',
    guidance: `Check current state before trying again: artium-axi az-axi api GET ${nativeTarget}/providers/Microsoft.Resources/tags/default`,
    check: ['api', 'GET', `${nativeTarget}/providers/Microsoft.Resources/tags/default`, '--api-version', '2021-04-01'] },
  { name: 'GET read', args: ['api', 'GET', readTarget, '--api-version', '2022-12-01'],
    code: 'TIMEOUT', path: readTarget, mutations: 0, method: 'GET', operation: 'exceeded its timeout',
    guidance: 'Check the tool status before retrying.', check: ['sub', 'list'] },
])('$name preserves its outcome when the fake service holds its response', async ({ args, code, path, mutations, method, operation, guidance, check }) => {
  await withAzureGateway(async ({ run, send, db }) => {
      const response = await run(args)
      expect(response.statusCode).toBe(504)
      const error = errorResponseSchema.parse(response.json()).error
      expect(error.code).toBe(code)
      expect(error.message).toContain(operation)
      expect(error.next).toContain(guidance)
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(mutations)
      expect(evidence.requests.filter((request: { path: string, method: string }) => request.path === path &&
        request.method === method)).toHaveLength(1)
      expect(db.prepare("SELECT outcome, action FROM audit WHERE event = 'run-terminal'").get())
        .toEqual({ outcome: code, action: 'unknown' })
      const recovered = await run(check)
      expect(recovered.statusCode).toBe(200)
      expect(runSuccessSchema.parse(recovered.json()).exitCode).toBe(0)
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(mutations)
  })
})

test.each([
  { name: 'trimmed tag scope', args: ['tag', 'update', '-s', subscription, '--resource-id', `  ${nativeTarget}///  `,
    '--operation', 'merge', '--tags', 'synthetic=yes', '--execute'],
    state: { properties: { tags: { synthetic: 'yes' } } } },
  { name: 'single trailing slash', args: ['tag', 'update', '-s', subscription, '--resource-id', `${nativeTarget}/`,
    '--operation', 'merge', '--tags', 'synthetic=yes', '--execute'],
    state: { properties: { tags: { synthetic: 'yes' } } } },
  { name: 'subscription alert', args: ['security', 'alert', 'update', '-s', subscription, '-l', ' synthetic location ',
    '-n', ' runner-timeout-alert ', '--status', 'resolve', '--execute'], state: { properties: { status: 'Resolved' } } },
  { name: 'group alert alias', args: ['defender', 'alerts', 'update', '-s', ` ${subscription}, `, '-g', ' synthetic group ',
    '-l', 'synthetic location', '-n', 'runner-timeout-alert', '--status', 'resolve', '--execute'],
    state: { properties: { status: 'Resolved' } } },
])('$name recovery exposes the applied state', async ({ args, state }) => {
  await withAzureGateway(async ({ run, send }) => {
    const response = await run(args)
    expect(response.statusCode).toBe(504)
    const error = errorResponseSchema.parse(response.json()).error
    expect(error.code).toBe('UNKNOWN_OUTCOME')
    const command = error.next.split('Check current state before trying again: ')[1]
    const recovered = await run(hostedArgs(command))
    expect(recovered.statusCode).toBe(200)
    const result = runSuccessSchema.parse(recovered.json())
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject(state)
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
})

test.each([
  ['--ids', ` ${incidentTarget} `],
  ['--incident-id', ` ${incidentId} `, '-g', ' runner-timeout-recovery ', '--workspace-name', ' synthetic workspace '],
  ['--incident-id', '17', '-g', 'runner-timeout-recovery', '--workspace-name', 'synthetic workspace'],
  ['--incident-id', incidentId, '--workspace', 'synthetic'],
  ['--incident-id', '17', '--workspace', '33333333-3333-4333-8333-333333333333'],
].map(selectors => [selectors]))('comment recovery exposes the applied comment for %j', async selectors => {
  await withAzureGateway(async ({ run, send }) => {
    const response = await run(['sentinel', 'incident', 'comment', 'create', '-s', subscription,
      ...selectors, '--message', 'synthetic applied comment', '--execute'])
    expect(response.statusCode).toBe(504)
    const error = errorResponseSchema.parse(response.json()).error
    expect(error.code).toBe('UNKNOWN_OUTCOME')
    const first = error.next.split('Check current state before trying again: ')[1].split('. Use the returned incident id')[0]
    const selected = await run(hostedArgs(first))
    expect(selected.statusCode).toBe(200)
    const selectedResult = runSuccessSchema.parse(selected.json())
    expect(selectedResult.exitCode).toBe(0)
    const incident = decode(selectedResult.stdout) as { id: string }
    expect(incident.id).toBe(incidentTarget)
    const second = error.next.split('inspect the comments before retrying: ')[1].replace('<incident-ARM-id>', incident.id)
    const recovered = await run(hostedArgs(second))
    expect(recovered.statusCode).toBe(200)
    const result = runSuccessSchema.parse(recovered.json())
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ value: [{ properties: { message: 'synthetic applied comment' } }] })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
})

test.each([
  { selectors: ['--ids', ` ${incidentTarget} `], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--name', ` ${incidentId} `, '-g', ' runner-timeout-recovery ', '--workspace-name', ' synthetic workspace '], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--incident-id', incidentId, '-g', 'runner-timeout-recovery', '--workspace-name', 'synthetic workspace'], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--name', '17', '-g', 'runner-timeout-recovery', '--workspace-name', 'synthetic workspace'], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--incident-id', incidentId, '--workspace', 'synthetic'], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--name', '17', '--workspace', '33333333-3333-4333-8333-333333333333'], owner: incidentId, expectedOwner: { objectId: incidentId } },
  { selectors: ['--ids', incidentTarget], owner: 'synthetic@example.test', expectedOwner: { email: 'synthetic@example.test', userPrincipalName: 'synthetic@example.test' } },
  { selectors: ['--ids', incidentTarget], owner: 'Synthetic Analyst', expectedOwner: { assignedTo: 'Synthetic Analyst' } },
])('incident recovery exposes every changed field for $selectors and $owner', async ({ selectors, owner, expectedOwner }) => {
  await withAzureGateway(async ({ run, send }) => {
    const comment = 'synthetic classification '.repeat(160) + 'synthetic tail'
    const response = await run(['sentinel', 'incident', 'update', '-s', subscription, ...selectors,
      '--status', 'Closed', '--severity', 'High', '--classification', 'TruePositive',
      '--classification-reason', 'SuspiciousActivity', '--classification-comment', comment, '--owner', owner, '--execute'])
    expect(response.statusCode).toBe(504)
    const error = errorResponseSchema.parse(response.json()).error
    expect(error.code).toBe('UNKNOWN_OUTCOME')
    const first = error.next.split('Check current state before trying again: ')[1].split('. Use the returned incident id')[0]
    const selected = await run(hostedArgs(first))
    expect(selected.statusCode).toBe(200)
    const selectedResult = runSuccessSchema.parse(selected.json())
    expect(selectedResult.exitCode).toBe(0)
    const incident = decode(selectedResult.stdout) as { id: string }
    expect(incident.id).toBe(incidentTarget)
    const second = error.next.split('inspect all incident fields before retrying: ')[1].replace('<incident-ARM-id>', incident.id)
    const recovered = await run(hostedArgs(second))
    expect(recovered.statusCode).toBe(200)
    const result = runSuccessSchema.parse(recovered.json())
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ properties: { status: 'Closed', severity: 'High',
      classification: 'TruePositive', classificationReason: 'SuspiciousActivity', classificationComment: comment,
      owner: expectedOwner } })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
})

test.each([
  { selectors: ['--ids', `/subscriptions/${subscription}/resourceGroups/runner-timeout-recovery/providers/Microsoft.Network/networkSecurityGroups/synthetic nsg`],
    sourcePorts: ['1000-2000'], sourceAddresses: ['10.0.0.0/24'], destinationPorts: ['443'], destinationAddresses: ['10.1.0.0/24'],
    expected: { sourcePortRange: '1000-2000', sourceAddressPrefix: '10.0.0.0/24', destinationPortRange: '443', destinationAddressPrefix: '10.1.0.0/24' } },
  { selectors: ['--nsg-name', ' synthetic nsg ', '-g', ' runner-timeout-recovery '],
    sourcePorts: ['1000-2000', '3000'], sourceAddresses: ['10.0.0.0/24', '10.2.0.0/24'], destinationPorts: ['443', '8443'], destinationAddresses: ['10.1.0.0/24', '10.3.0.0/24'],
    expected: { sourcePortRanges: ['1000-2000', '3000'], sourceAddressPrefixes: ['10.0.0.0/24', '10.2.0.0/24'],
      destinationPortRanges: ['443', '8443'], destinationAddressPrefixes: ['10.1.0.0/24', '10.3.0.0/24'] } },
])('rule recovery exposes every changed field for $selectors', async ({ selectors, sourcePorts, sourceAddresses, destinationPorts, destinationAddresses, expected }) => {
  await withAzureGateway(async ({ run, send }) => {
    const response = await run(['network', 'nsg', 'rule', 'create', '-s', subscription, ...selectors,
      '-n', 'synthetic-rule', '--priority', '123', '--direction', 'Outbound', '--access', 'Deny', '--protocol', 'Tcp',
      '--source-address-prefixes', ...sourceAddresses, '--source-port-ranges', ...sourcePorts,
      '--destination-address-prefixes', ...destinationAddresses, '--destination-port-ranges', ...destinationPorts,
      '--description', 'synthetic rule description', '--execute', '--confirm', 'synthetic-rule'])
    expect(response.statusCode).toBe(504)
    const error = errorResponseSchema.parse(response.json()).error
    expect(error.code).toBe('UNKNOWN_OUTCOME')
    const recovered = await run(hostedArgs(error.next.split('Check current state before trying again: ')[1]))
    expect(recovered.statusCode).toBe(200)
    const result = runSuccessSchema.parse(recovered.json())
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ name: 'synthetic-rule', properties: {
      description: 'synthetic rule description', protocol: 'Tcp', ...expected,
      access: 'Deny', priority: 123, direction: 'Outbound' } })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
})

test.each([[[]], [['home']]])('dashboard %j performs authenticated ARM reads', async args => {
  await withFakeService(async ({ directory, port, send }) => {
    const runner = await Runner.create(join(directory, 'calls'))
    const adapter = createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
      subscriptions: [subscription], allowWrites: true }) }, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
    try {
      const call = await adapter.prepare(args, { id: 'synthetic-azure', tool: 'az-axi', revision: 1 })
      const result = await runner.run('synthetic-user', process.execPath,
        ['--import', fileURLToPath(new URL('../fake-service/azure-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', import.meta.url)), ...call.args],
        { ...call.environment, NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt'), ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}` },
        call.secrets, { timeoutMs: 5000 }, {}, call.files)
      expect(result.exitCode).toBe(0)
      const dashboard = decode(result.stdout) as { help?: string[], exposure: unknown }
      expect(dashboard.help?.join('\n') ?? '').not.toContain('Could not')
      expect(dashboard.exposure).toEqual({ publicIps: 1, mgmtPorts: 1, anyAny: 1 })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(0)
      expect(evidence.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/subscriptions', method: 'GET', canaryReceived: true }),
        expect.objectContaining({ path: '/providers/Microsoft.ResourceGraph/resources', method: 'POST', canaryReceived: true }),
      ]))
    } finally { await runner.shutdown() }
  })
})

test('API runner timeout recovery exposes the complete long changed value', async () => {
  await withAzureGateway(async ({ run, send }) => {
    const value = 'synthetic classification '.repeat(200)
    const response = await run(['api', 'PUT', incidentTarget, '--api-version', '2025-09-01', '--execute'],
      { stdin: JSON.stringify({ properties: { classificationComment: value } }) })
    expect(response.statusCode).toBe(504)
    const error = errorResponseSchema.parse(response.json()).error
    expect(error.code).toBe('UNKNOWN_OUTCOME')
    const recovered = await run(hostedArgs(error.next.split('Check current state before trying again: ')[1]))
    expect(recovered.statusCode).toBe(200)
    const result = runSuccessSchema.parse(recovered.json())
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ properties: { classificationComment: value } })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
})

test.each(['504', 'drop'].flatMap(outcome => ['json', 'toon'].flatMap(format => [
  { outcome: outcome as '504' | 'drop', format, name: 'incident update', command: ['sentinel', 'incident', 'update', '-s', subscription, '--ids', incidentTarget,
    '--classification', 'TruePositive', '--classification-reason', 'SuspiciousActivity', '--classification-comment'], field: 'classificationComment' },
  { outcome: outcome as '504' | 'drop', format, name: 'comment creation', command: ['sentinel', 'incident', 'comment', 'create', '-s', subscription, '--ids', incidentTarget,
    '--message'], field: 'message' },
])))('$name upstream $outcome recovery exposes the complete value through $format', async ({ outcome, format, command, field }) => {
  await withAzureGateway(async ({ run, send }) => {
    const value = 'synthetic long changed value '.repeat(140) + 'synthetic tail'
    const response = await run([...command, value, '--execute'])
    expect(response.statusCode).toBe(200)
    const failed = runSuccessSchema.parse(response.json())
    expect(failed.exitCode).toBe(1)
    const upstream = decode(failed.stdout) as { code: string, help: string[] }
    expect(upstream.code).toBe('UNKNOWN_OUTCOME')
    const serialized = format === 'json' ? JSON.stringify(upstream) : encode(upstream)
    const output = rewriteSuggestions(serialized, 'az-axi')
    const hosted = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof upstream
    const suggestions = hosted.help.filter(line => /^(?:Check current state before trying again:|Verify with) /.test(line))
    expect(suggestions).toHaveLength(2)
    for (const suggestion of suggestions) {
      const emitted = suggestion.slice(suggestion.indexOf('`') + 1, -1)
      const recovered = await run(hostedArgs(emitted))
      expect(recovered.statusCode).toBe(200)
      const result = runSuccessSchema.parse(recovered.json())
      expect(result.exitCode).toBe(0)
      expect(decode(result.stdout)).toMatchObject({ properties: { [field]: value } })
    }
    expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.mutations).toBe(1)
    expect(evidence.requests.filter((request: { method: string }) => request.method === 'PUT')).toHaveLength(1)
  }, outcome)
})
