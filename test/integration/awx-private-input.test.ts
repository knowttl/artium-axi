import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

test.each(['module-args', 'args'].flatMap(flag => ['inline', 'upload'].map(channel => ({ flag, channel }))))(
  'AWX --$flag $channel arguments stay private in previews and confirmed responses (R6)', async ({ flag, channel }) => {
    await withFakeService(async ({ directory, port, send }) => {
      const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
      const db = openStore(join(directory, 'artium.db'), provider)
      await seedToolUser(db)
      db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
      const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
      const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
        token: 'CANARY-awx-token', allowWrites: true }) })
      const prepare = adapter.prepare.bind(adapter)
      adapter.prepare = async (...input) => {
        const call = await prepare(...input)
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
      const lines: string[] = []
      const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
        resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
      const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
      const content = 'url=https://synthetic.invalid url_password=CANARY-module-password'
      const args = ['ad-hoc', 'launch', '7', '--module-name', 'uri', `--${flag}`, channel === 'inline' ? content : 'args.txt']
      const input = channel === 'upload' ? { files: [upload('args.txt', content)] } : {}
      try {
        const preview = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers,
          payload: { args: [...args, '--dry-run'], ...input } })
        expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
        expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { module_args: '[structured input redacted, 65 bytes]' } })
        expect(preview.body).not.toContain('CANARY-')
        expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
        const written = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers,
          payload: { args: [...args, '--confirm'], ...input } })
        expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
        expect(written.body).not.toContain('CANARY-')
        expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 1, requests: [{
          method: 'POST', path: '/api/v2/ad_hoc_commands/', canaryReceived: true, body: { module_args: content },
        }] })
        const call = await adapter.prepare([...args, '--confirm'], reference, input)
        expect(call.args.join(' ')).not.toContain('CANARY-')
        expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
        expect(readdirSync(join(directory, 'calls'))).toEqual([])
      } finally { await app.close(); db.close() }
    })
  }, 60_000,
)

test('AWX protocol metadata survives structured values through completion and uncertain writes (R3)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites: true }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    try {
      const launched = await run(['ad-hoc', 'launch', '7', '--extra-vars', '{"mode":"pending"}', '--confirm'])
      expect(launched.json(), launched.body).toMatchObject({ exitCode: 0 })
      expect(decode(launched.json().stdout)).toMatchObject({ ad_hoc_command: { status: 'pending' } })
      await send('/__ado/reset', 'POST')
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await run(['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"mode":"A"}', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi host list --limit 100') } })
      expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 1,
        requests: [{ method: 'POST', path: '/api/v2/hosts/', body: { name: 'synthetic', inventory: 7, variables: '{"mode":"A"}' } }] })
      const recovered = await run(['host', 'list', '--limit', '100'])
      expect(recovered.json(), recovered.body).toMatchObject({ exitCode: 0 })
      expect(decode(recovered.json().stdout)).toMatchObject({ hosts: [{ id: 42, name: 'synthetic' }] })
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test.each([
  { flag: 'variables', args: ['inventory', 'host-create', 'synthetic', '--inventory', '7'], trailing: ['--description', 'placeholder'],
    path: '/api/v2/hosts/', field: 'variables', exitCode: 0 },
  { flag: 'source-vars', args: ['inventory', 'source-create', 'synthetic', '--inventory', '7'], trailing: ['--source', 'scm'],
    path: '/api/v2/inventory_sources/', field: 'source_vars', exitCode: 2 },
  { flag: 'extra-vars', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'extra_vars', exitCode: 0 },
  { flag: 'module-args', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'module_args', exitCode: 0 },
  { flag: 'args', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'module_args', exitCode: 0 },
].flatMap(route => ['inline', 'separate', 'upload'].map(channel => ({ ...route, channel }))))(
  'AWX structured --$flag $channel input cannot redirect the managed token (R2)',
  async ({ flag, args, trailing, path, field, exitCode, channel }) => {
    await withFakeService(async controller => {
      await withFakeService(async receiver => {
        const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
        const db = openStore(join(controller.directory, 'artium.db'), provider)
        await seedToolUser(db)
        db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
        const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
        const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${controller.port}`,
          token: 'CANARY-awx-token', allowWrites: true }) })
        const prepare = adapter.prepare.bind(adapter)
        adapter.prepare = async (...input) => {
          const call = await prepare(...input)
          call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
          return call
        }
        const runner = await Runner.create(join(controller.directory, 'calls'), {
          pem: [controller, receiver].map(service => readFileSync(join(service.directory, 'ca.crt'), 'utf8')).join('\n'), certificates: [],
        })
        const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
          resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
        try {
          const value = `--origin=https://localhost:${receiver.port}`
          const request = { args: [...args, ...(channel === 'separate' ? [`--${flag}`, value]
            : [`--${flag}=${channel === 'upload' ? 'input.txt' : value}`]), ...trailing, '--confirm'],
            ...(channel === 'upload' ? { files: [upload('input.txt', value)] } : {}) }
          const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', payload: request,
            headers: { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` } })
          expect(JSON.parse(await receiver.send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
          expect(response.json(), response.body).toMatchObject({ exitCode })
          const evidence = JSON.parse(await controller.send('/__evidence'))
          expect(evidence.mutations).toBe(exitCode === 0 ? 1 : 0)
          if (exitCode === 0) expect(evidence.requests).toContainEqual(expect.objectContaining({
            method: 'POST', path, canaryReceived: true, body: expect.objectContaining({ [field]: value }),
          }))
          const call = await adapter.prepare(request.args, reference, request)
          expect(call.args).toContain(`--${flag}=private-input`)
          expect(call.args.join(' ')).not.toContain(value)
          expect(response.body).not.toContain('CANARY-awx-token')
        } finally { await app.close(); db.close() }
      })
    })
  }, 60_000,
)
