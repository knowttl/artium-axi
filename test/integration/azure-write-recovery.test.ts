import { expect, test, vi } from 'vitest'
import { errorResponseSchema, runSuccessSchema } from '../../src/shared/api.js'
import { decode } from '@toon-format/toon'
import { azureGatewayTimeoutMs, hostedArgs, subscription, withAzureGateway } from '../fixtures/azure-gateway.js'

const apiTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-api`
const nativeTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-native`
const readTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-read`
const incidentId = '11111111-1111-4111-8111-111111111111'
const incidentTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-recovery/providers/Microsoft.OperationalInsights/workspaces/synthetic workspace/providers/Microsoft.SecurityInsights/incidents/${incidentId}`

async function withRecoveryGateway(check: Parameters<typeof withAzureGateway>[0]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    // The real service has applied the request and withheld its response before the runner deadline fires.
    await withAzureGateway(check, 'hold', () => vi.advanceTimersByTime(azureGatewayTimeoutMs))
  } finally {
    vi.useRealTimers()
  }
}

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
  await withRecoveryGateway(async ({ run, send, db }) => {
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
  { name: 'subscription alert', args: ['security', 'alert', 'update', '-s', subscription, '-l', ' synthetic location ',
    '-n', ' runner-timeout-alert ', '--status', 'resolve', '--execute'], state: { properties: { status: 'Resolved' } } },
])('$name recovery exposes the applied state', async ({ args, state }) => {
  await withRecoveryGateway(async ({ run, send }) => {
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
].map(selectors => [selectors]))('comment recovery exposes the applied comment for %j', async selectors => {
  await withRecoveryGateway(async ({ run, send }) => {
    const response = await run(['sentinel', 'incident', 'comment', 'create', '-s', subscription,
      ...selectors, '--message', 'synthetic applied comment', '--execute'])
    expect(response.statusCode, JSON.stringify({ selectors, response: response.json() })).toBe(504)
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
])('incident recovery exposes every changed field for $selectors and $owner', async ({ selectors, owner, expectedOwner }) => {
  await withRecoveryGateway(async ({ run, send }) => {
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
  await withRecoveryGateway(async ({ run, send }) => {
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

test('API runner timeout recovery exposes the complete long changed value', async () => {
  await withRecoveryGateway(async ({ run, send }) => {
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
