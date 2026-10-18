import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { decode, encode } from '@toon-format/toon'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { Runner } from '../../src/server/runner/runner.js'
import { runSuccessSchema } from '../../src/shared/api.js'
import { rewriteSuggestions } from '../../src/cli/rewrite.js'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { hostedArgs, subscription, withAzureGateway } from '../fixtures/azure-gateway.js'

const apiTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-api`
const incidentTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-recovery/providers/Microsoft.OperationalInsights/workspaces/synthetic workspace/providers/Microsoft.SecurityInsights/incidents/11111111-1111-4111-8111-111111111111`

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

test.each([
  { outcome: '504' as const, format: 'json', name: 'incident update', command: ['sentinel', 'incident', 'update', '-s', subscription, '--ids', incidentTarget,
    '--classification', 'TruePositive', '--classification-reason', 'SuspiciousActivity', '--classification-comment'], field: 'classificationComment' },
  { outcome: 'drop' as const, format: 'toon', name: 'comment creation', command: ['sentinel', 'incident', 'comment', 'create', '-s', subscription, '--ids', incidentTarget,
    '--message'], field: 'message' },
])('$name upstream $outcome recovery exposes the complete value through $format', async ({ outcome, format, command, field }) => {
  await withAzureGateway(async ({ run, send }) => {
    const value = 'synthetic long changed value '.repeat(140) + 'synthetic tail'
    const response = await run([...command, value, '--execute'])
    expect(response.statusCode).toBe(200)
    const failed = runSuccessSchema.parse(response.json())
    expect(failed.exitCode).toBe(1)
    const upstream = decode(failed.stdout) as { code: string, help: string[] }
    expect(upstream.code, JSON.stringify({ command, response: response.json(), evidence: JSON.parse(await send('/__evidence')) })).toBe('UNKNOWN_OUTCOME')
    const serialized = format === 'json' ? JSON.stringify(upstream) : encode(upstream)
    const output = rewriteSuggestions(serialized, 'az-axi')
    const hosted = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof upstream
    const suggestions = hosted.help.filter(line => /^(?:Check current state before trying again:|Verify with) /.test(line))
    expect(suggestions).toHaveLength(2)
    for (const suggestion of suggestions) {
      const emitted = suggestion.slice(suggestion.indexOf('`') + 1, -1)
      const recovered = await run(hostedArgs(emitted))
      const diagnostic = JSON.stringify({ command: emitted, statusCode: recovered.statusCode, response: recovered.json() })
      expect(recovered.statusCode, diagnostic).toBe(200)
      const result = runSuccessSchema.parse(recovered.json())
      expect(result.exitCode, diagnostic).toBe(0)
      expect(decode(result.stdout)).toMatchObject({ properties: { [field]: value } })
    }
    expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.mutations).toBe(1)
    expect(evidence.requests.filter((request: { method: string }) => request.method === 'PUT')).toHaveLength(1)
  }, outcome)
})
