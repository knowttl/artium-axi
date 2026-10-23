import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { toolSchema } from '../../src/shared/api.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { createTenableAdapter } from '../../src/server/adapters/tenable.js'
import { createHybridAdapter } from '../../src/server/adapters/hybrid.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { Runner } from '../../src/server/runner/runner.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { createLdapService } from '../fake-service/ldap.mjs'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'

const identity = { tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222' }
const profile = (tool: 'mg-axi' | 'vectra-axi') => loadCredentialProfile(tool,
  join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))!

test.each(toolSchema.options.flatMap(tool => (['server', 'credential'] as const).map(source => ({ tool, source }))))('$tool inherits $source child trust and retains credential-specific CAs', async ({ tool, source: trustSource }) => {
  await withFakeService(async ({ directory }) => {
    const pem = readFileSync(join(directory, 'ca.crt'), 'utf8')
    const credentials = {
      'hybrid-axi': { apiKey: 'CANARY-hybrid-key' },
      'tenable-axi': { accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-secret' },
      'awx-axi': { origin: 'https://controller.example', token: 'CANARY-awx-token' },
      'ado-axi': { org: 'synthetic-org', auth: 'pat', token: 'CANARY-ado-pat' },
      'falcon-axi': { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-1' },
      'vectra-axi': { kind: 'qux', origin: 'https://appliance.test', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra', caBundle: pem },
      'az-axi': { ...identity, auth: 'secret', clientSecret: 'CANARY-azure' },
      'mg-axi': { ...identity, mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph' },
      'ldap-axi': { url: 'ldaps://localhost', auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap', caFile: pem },
    }
    const source = { getCredential: async () => credentials[tool] }
    const log = join(directory, 'writes.log')
    const adapters = {
      'hybrid-axi': createHybridAdapter(source, log),
      'tenable-axi': createTenableAdapter(source, log),
      'awx-axi': createAwxAdapter(source),
      'ado-axi': createAdoAdapter(source),
      'falcon-axi': createFalconAdapter(source, log),
      'vectra-axi': createVectraAdapter(source, log, profile('vectra-axi')),
      'az-axi': createAzAdapter(source, log, new AzureTokenCache(new FakeTokenTransport())),
      'mg-axi': createMgAdapter(source, log, profile('mg-axi')),
      'ldap-axi': createLdapAdapter(source),
    }
    const args = { 'hybrid-axi': ['quota'], 'tenable-axi': ['card', 'list'], 'awx-axi': ['job', 'list'], 'falcon-axi': ['auth', 'status'], 'vectra-axi': ['health', 'list'],
      'az-axi': ['account', 'list'], 'mg-axi': ['entra', 'user', 'list'], 'ldap-axi': ['auth', 'status'], 'ado-axi': ['project', 'list'] }
    const call = await adapters[tool].prepare(args[tool], { id: 'synthetic-credential', tool, revision: 1 })
    const runner = await Runner.create(join(directory, 'calls'), trustSource === 'server' ? loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }) : undefined)
    const node = `const fs = require('node:fs'); console.log(JSON.stringify({
      node: fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8'),
      python: fs.readFileSync(process.env.REQUESTS_CA_BUNDLE, 'utf8'),
      files: JSON.parse(process.env.ARTIUM_TEST_CA_FILES).map(name => fs.readFileSync(name, 'utf8'))
    }))`
    const python = `import json,os; print(json.dumps({'node': open(os.environ['NODE_EXTRA_CA_CERTS']).read(), 'python': open(os.environ['REQUESTS_CA_BUNDLE']).read(), 'files': []}))`
    try {
      const result = await runner.run('synthetic-user', tool === 'falcon-axi' ? '/usr/bin/python3' : process.execPath,
        tool === 'falcon-axi' ? ['-c', python] : ['-e', node],
        { ...call.environment, ARTIUM_TEST_CA_FILES: JSON.stringify(call.files.filter(file => file.appendTrustedCa).map(file => file.name)) },
        call.secrets, { ...call.limits, ...(trustSource === 'credential' ? { credentialTrust: [{
          endpoint: 'https://appliance.test/', pem, fingerprint: 'synthetic', leafFingerprint: 'synthetic', mode: 'pin' as const,
        }] } : {}) }, {}, call.files)
      expect(result.exitCode, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout)
      if (trustSource === 'server') expect(output.node).toContain(pem)
      else expect(output.node).not.toContain(pem)
      expect(output.python).toBe(output.node)
      expect(output.node.match(/BEGIN CERTIFICATE/g).length).toBeGreaterThan(1)
      for (const content of output.files) expect(content).toBe(pem + '\n' + output.node)
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await runner.shutdown() }
  })
})

test.each(['node', 'python'] as const)('%s verifies a private-CA upstream only with central runner trust', async runtime => {
  await withFakeService(async ({ directory, port }) => {
    const url = `https://localhost:${port}/`
    const executable = runtime === 'node' ? process.execPath : '/usr/bin/python3'
    const args = runtime === 'node'
      ? ['-e', `fetch(${JSON.stringify(url)}).then(r => r.text()).then(console.log).catch(() => process.exitCode = 1)`]
      : ['-c', `import requests; print(requests.get(${JSON.stringify(url)}, timeout=3).text)`]
    const untrusted = await Runner.create(join(directory, 'untrusted'))
    const trusted = await Runner.create(join(directory, 'trusted'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      const limits = runtime === 'python' ? { runtime: 'python' as const } : {}
      expect((await untrusted.run('synthetic-user', executable, args, {}, [], limits)).exitCode).not.toBe(0)
      const result = await trusted.run('synthetic-user', executable, args, {}, [], limits)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ value: [] })
    } finally { await Promise.all([untrusted.shutdown(), trusted.shutdown()]) }
  })
})

test.each([false, true])('published Vectra trusts the server CA with credential CA configured: %s', async credentialCa => {
  await withFakeService(async ({ directory, port }) => {
    const adapter = createVectraAdapter({ getCredential: async () => ({ kind: 'qux', apiVersion: '2.5',
      origin: `https://localhost:${port}`, auth: 'token', token: 'CANARY-vectra',
      ...(credentialCa ? { caBundle: readFileSync(join(directory, 'server.crt'), 'utf8') } : {}) }) },
    join(directory, 'writes.log'), profile('vectra-axi'))
    const call = await adapter.prepare(['detection', 'list'], { id: 'synthetic-vectra', tool: 'vectra-axi' })
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      const result = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js'), ...call.args],
        call.environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('0 detections')
    } finally { await runner.shutdown() }
  })
})

test.each([false, true])('published LDAP verifies private-CA LDAPS with credential CA configured: %s', async credentialCa => {
  await withFakeService(async ({ directory }) => {
    const service = createLdapService(directory)
    service.listen(0, '127.0.0.1')
    await once(service, 'listening')
    const port = (service.address() as { port: number }).port
    const adapter = createLdapAdapter({ getCredential: async () => ({ url: `ldaps://localhost:${port}`,
      auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap',
      ...(credentialCa ? { caFile: readFileSync(join(directory, 'server.crt'), 'utf8') } : {}) }) })
    const call = await adapter.prepare(['auth', 'status'], { id: 'synthetic-ldap', tool: 'ldap-axi' })
    const untrusted = await Runner.create(join(directory, 'untrusted'))
    const trusted = await Runner.create(join(directory, 'trusted'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const args = [join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js'), ...call.args]
    try {
      const failed = await untrusted.run('synthetic-user', process.execPath, args, call.environment, call.secrets, call.limits, {}, call.files)
      expect(failed.exitCode, failed.stdout).not.toBe(0)
      const passed = await trusted.run('synthetic-user', process.execPath, args, call.environment, call.secrets, call.limits, {}, call.files)
      expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
      expect(passed.stdout).toContain('tls: verified')
    } finally {
      await Promise.all([untrusted.shutdown(), trusted.shutdown()])
      await new Promise<void>(resolve => service.close(() => resolve()))
    }
  })
})

test.each(['az-axi', 'mg-axi'] as const)('published %s verifies private-CA HTTPS through runner trust', async tool => {
  await withFakeService(async ({ directory, port, send }) => {
    const source = { getCredential: async () => tool === 'az-axi'
      ? { ...identity, auth: 'secret', clientSecret: 'CANARY-azure' }
      : { ...identity, mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph' } }
    const adapter = tool === 'az-axi'
      ? createAzAdapter(source, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
      : createMgAdapter(source, join(directory, 'writes.log'), profile('mg-axi'))
    const call = await adapter.prepare(tool === 'az-axi' ? ['account', 'list'] : ['entra', 'user', 'list'],
      { id: 'synthetic-credential', tool, revision: 1 })
    const args = tool === 'az-axi'
      ? ['--import', join(process.cwd(), 'test/fake-service/azure-transport.mjs'),
        join(process.cwd(), 'tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js'), ...call.args]
      : [join(process.cwd(), 'test/fake-service/graph-trust.mjs'), ...call.args]
    const environment = { ...call.environment, ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}`,
      ARTIUM_TEST_GRAPH_ORIGIN: `https://localhost:${port}` }
    const untrusted = await Runner.create(join(directory, 'untrusted'))
    const trusted = await Runner.create(join(directory, 'trusted'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    try {
      expect((await untrusted.run('synthetic-user', process.execPath, args, environment, call.secrets, call.limits, {}, call.files)).exitCode).not.toBe(0)
      const result = await trusted.run('synthetic-user', process.execPath, args, environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests).toHaveLength(1)
      expect(evidence.requests[0].canaryReceived).toBe(true)
    } finally { await Promise.all([untrusted.shutdown(), trusted.shutdown()]) }
  })
})
