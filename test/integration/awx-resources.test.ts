import { configurationTests } from './awx-configuration-cases.js'
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
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

test('AWX execution environment image edits and interrupted renames remain readable with writes disabled (S9)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites, allowSecurityAdministration: true }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    const run = async (args: string[]) => {
      const response = await request(args)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['execution-environment', 'create', '--name', 'Synthetic runner', '--image', 'registry.example/runner:v1', '--confirm'])
      expect(await run(['execution-environment', 'edit', 'Synthetic runner', '--image', 'registry.example/runner:v2',
        '--credential', '9', '--pull', 'missing', '--dry-run'])).toMatchObject({ dry_run: { payload: {
        image: 'registry.example/runner:v2', credential: 9, pull: 'missing' } } })
      expect(await run(['execution-environment', 'show', '42'])).toMatchObject({ execution_environment: { image: 'registry.example/runner:v1' } })
      await run(['execution-environment', 'edit', 'Synthetic runner', '--image', 'registry.example/runner:v2',
        '--credential', '9', '--pull', 'missing', '--confirm'])
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['execution-environment', 'edit', '42', '--name', 'Synthetic renamed runner', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi execution-environment list --limit 100') } })
      allowWrites = false
      expect(await run(['execution-environment', 'list'])).toMatchObject({ execution_environments: [
        { id: 42, name: 'Synthetic renamed runner', image: 'registry.example/runner:v2' },
      ] })
      expect(await run(['execution-environment', 'show', 'Synthetic renamed runner'])).toMatchObject({
        execution_environment: { id: 42, name: 'Synthetic renamed runner', image: 'registry.example/runner:v2' },
      })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests.filter((entry: { method: string }) => entry.method !== 'GET')).toEqual([
        expect.objectContaining({ method: 'POST', path: '/api/v2/execution_environments/',
          body: { name: 'Synthetic runner', image: 'registry.example/runner:v1' } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/execution_environments/42/',
          body: { image: 'registry.example/runner:v2', credential: 9, pull: 'missing' } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/execution_environments/42/', body: { name: 'Synthetic renamed runner' } }),
      ])
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX machine credential writes preserve private inputs and reconcile interrupted team creation (S5-001)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    let allowWrites = true
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites, allowSecurityAdministration: true }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], input: RunInput = {}) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
    try {
      const machine = { username: 'synthetic-ssh', ssh_key_data: '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-synthetic-key\n-----END OPENSSH PRIVATE KEY-----',
        password: 'CANARY-machine-password' }
      const input = { files: [upload('machine.json', JSON.stringify(machine))] }
      const create = ['credential', 'create', 'Synthetic machine', '--credential-type', 'Machine', '--organization', '7', '--inputs-file', 'machine.json', '--confirm']
      const created = await run(create, input)
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      expect(decode(created.json().stdout)).toMatchObject({ credential: { id: 42, name: 'Synthetic machine' } })
      const edited = await run(['credential', 'edit', '42', '--inputs-file', '-', '--confirm'], { stdin: '{"password":"CANARY-replaced-password"}' })
      expect(edited.json(), edited.body).toMatchObject({ exitCode: 0 })
      const copied = await run(['credential', 'copy', '42', '--name', 'Synthetic machine copy', '--confirm'])
      expect(copied.json(), copied.body).toMatchObject({ exitCode: 0 })
      expect(decode(copied.json().stdout)).toMatchObject({ credential: { id: 43, name: 'Synthetic machine copy' } })
      const invalidType = await run(['credential', 'create', 'Synthetic invalid', '--credential-type', '999', '--confirm'])
      expect(invalidType.json(), invalidType.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      const invalidInputs = await run(['credential', 'edit', '42', '--inputs-file', '-', '--confirm'], { stdin: '["CANARY-invalid-input"]' })
      expect(invalidInputs.json(), invalidInputs.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 3, requests: expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/api/v2/credentials/', body: { name: 'Synthetic machine', credential_type: 7, organization: 7, inputs: machine } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/credentials/42/', body: { inputs: { password: 'CANARY-replaced-password' } } }),
        expect.objectContaining({ method: 'POST', path: '/api/v2/credentials/42/copy/', body: { name: 'Synthetic machine copy' } }),
      ]) })
      const call = await adapter.prepare(create, reference, input)
      expect(call.args.join(' ')).not.toContain('CANARY-')
      await run(['team', 'credential-create', '7', '--name', 'Synthetic team machine', '--credential-type', '7',
        '--inputs-file', 'machine.json', '--dry-run'], { files: [upload('machine.json', '{"password":"CANARY-team-machine"}')] })
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await run(['team', 'credential-create', '7', '--name', 'Synthetic team machine', '--credential-type', '7',
        '--inputs-file', 'machine.json', '--confirm'], { files: [upload('machine.json', '{"password":"CANARY-team-machine"}')] })
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi credential list --limit 100') } })
      allowWrites = false
      const recovered = await run(['credential', 'list', '--limit', '100'])
      expect(recovered.json(), recovered.body).toMatchObject({ exitCode: 0 })
      expect(decode(recovered.json().stdout)).toMatchObject({ credentials: [
        { id: 42, name: 'Synthetic machine' }, { id: 43, name: 'Synthetic machine copy' }, { id: 44, name: 'Synthetic team machine' },
      ] })
      const shown = await run(['credential', 'show', '43'])
      expect(shown.json(), shown.body).toMatchObject({ exitCode: 0 })
      expect(decode(shown.json().stdout)).toMatchObject({ credential: { id: 43, name: 'Synthetic machine copy' } })
      expect(created.body + edited.body + copied.body + invalidType.body + invalidInputs.body + interrupted.body + recovered.body + shown.body
        + lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'awx-axi' AND event = 'run-terminal' AND (action = 'write' OR outcome = 'UNKNOWN_OUTCOME') ORDER BY id").all())
        .toEqual([{ outcome: 'completed' }, { outcome: 'completed' }, { outcome: 'completed' }, { outcome: 'UNKNOWN_OUTCOME' }])
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
configurationTests(['project'])
