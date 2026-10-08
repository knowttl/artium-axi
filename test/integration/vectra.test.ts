import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'

const execute = promisify(execFile)
const binary = join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js')

test('pinned Vectra native gates, local parity, durable logs and user audit survive call cleanup', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const credential = { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra-token',
      origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8'),
      writes: { allowWrites: true, operations: ['qux.detection.tag.set'] } }
    const source = { getCredential: async () => credential }
    const writeLog = join(directory, 'tool-logs', 'vectra-axi', 'writes.log')
    const adapter = createVectraAdapter(source, writeLog)
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...args) => {
      const call = await prepare(...args)
      return { ...call, executable: process.execPath, args: [binary, ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 1) }
    }
    const db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
    db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.3' WHERE name = 'vectra-axi'")
    const token = 'CANARY-artium-token'
    const tokenFile = join(directory, 'token')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const runner = await Runner.create(join(directory, 'calls'))
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => { lines.push(line) }),
      resolver: new SharedIdentityResolver(new FakeCredentialStore([
        { reference: { id: 'synthetic-vectra', tool: 'vectra-axi' }, value: credential },
      ])), adapters: [adapter], environment: { ARTIUM_AXI_DEV: '1', ARTIUM_AXI_DEV_TOKEN_FILE: tokenFile } })
    try {
      const run = async (args: string[], input = {}) => {
        const reply = await app.inject({ method: 'POST', url: '/v1/tools/vectra-axi/run',
          headers: { authorization: `Bearer ${token}` }, payload: { args, ...input } })
        expect(reply.statusCode).toBe(200)
        return reply.json() as { stdout: string, stderr: string, exitCode: number }
      }
      const evidence = async () => JSON.parse(await send('/__evidence')) as { mutations: number, requests: { method: string, path: string }[] }
      const args = ['detection', 'tag', 'set', '--id', '42', '--tags', 'synthetic']
      const local = join(directory, 'local')
      mkdirSync(local, { mode: 0o700 })
      const call = await prepare(args, { id: 'synthetic-vectra', tool: 'vectra-axi' })
      for (const file of call.files) writeFileSync(join(local, file.name), file.content, { mode: 0o600 })
      const direct = await execute(process.execPath, [binary, ...args], { cwd: local,
        env: { ...call.environment, HOME: local, PATH: process.env.PATH }, timeout: 10_000 })
      const preview = await run(args)
      expect(preview).toMatchObject({ stdout: direct.stdout, stderr: direct.stderr, exitCode: 0 })
      expect(preview.stdout).toContain('current:')
      expect((await evidence()).mutations).toBe(0)
      expect((await run([...args, '--dry-run'])).stdout).toContain('current:')
      expect((await run([...args, '--execute'])).stdout).toContain('CONFIRM_REQUIRED')
      expect((await run([...args, '--execute', '--confirm', 'detection 43'])).stdout).toContain('CONFIRM_MISMATCH')
      credential.writes.allowWrites = false
      expect((await run(args)).stdout).toContain('WRITES_DISABLED')
      credential.writes.allowWrites = true
      credential.writes.operations = ['qux.host.tag.set']
      expect((await run(args)).stdout).toContain('OPERATION_NOT_WRITABLE')
      credential.writes.operations = ['qux.detection.tag.set']
      expect((await run(['detection', 'tag', 'set', '--id', '44', '--tags', 'synthetic', '--execute', '--confirm', 'detection 44'])).stdout)
        .toContain('ACCESS_DENIED')
      expect((await evidence()).mutations).toBe(0)
      const written = await run([...args, '--execute', '--confirm', 'detection 42'])
      expect(written.exitCode).toBe(0)
      expect(written.stdout).toContain('audit:')
      expect((await evidence()).mutations).toBe(1)
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
      const records = readFileSync(writeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(records.map(record => record.kind)).toEqual(['intent', 'outcome'])
      expect(records[1]).toMatchObject({ outcome: 'SUCCESS', operation: 'qux.detection.tag.set' })
      expect(statSync(writeLog).mode & 0o777).toBe(0o600)
      expect(statSync(join(directory, 'tool-logs', 'vectra-axi')).mode & 0o777).toBe(0o700)
      expect(db.prepare("SELECT user_id, tool, outcome FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ user_id: 'synthetic-development-user', tool: 'vectra-axi', outcome: 'completed' })
      expect(lines.join('')).not.toContain(credential.token)
      // The pinned tool reads uploaded file contents or bounded stdin, never caller-selected server paths.
      expect((await run(['detection', 'tag', 'set', '--id', '42', '--tags-file=tags.txt'], {
        files: [{ name: 'tags.txt', contentBase64: Buffer.from('synthetic\n').toString('base64') }],
      })).stdout).toContain('current:')
      expect((await run(['detection', 'tag', 'set', '--id', '42', '--tags-file', '-'], { stdin: 'synthetic\n' })).stdout).toContain('current:')
      const before = (await evidence()).mutations
      const uncertain = await run(['detection', 'tag', 'set', '--id', '43', '--tags', 'synthetic', '--execute', '--confirm', 'detection 43'])
      expect(uncertain.exitCode).not.toBe(0)
      expect(uncertain.stdout).toContain('Read back')
      expect((await evidence()).mutations).toBe(before + 1)
      const lostResponse = await run(['detection', 'tag', 'set', '--id', '45', '--tags', 'synthetic', '--execute', '--confirm', 'detection 45'])
      expect(lostResponse.exitCode).not.toBe(0)
      expect(lostResponse.stdout).toContain('may or may not have been applied')
      expect((await evidence()).mutations).toBe(before + 2)
      const journal = readFileSync(writeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(journal.at(-1)).toMatchObject({ outcome: 'OUTCOME_UNKNOWN', httpStatus: 0 })
    } finally { await app.close(); db.close() }
  })
}, 30_000)
