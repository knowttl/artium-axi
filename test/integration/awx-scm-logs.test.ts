import { configurationTests } from './awx-configuration-cases.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:https'
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

test.each([
  { view: 'default', flags: [], range: '0-4 of 4', body: "Fetching repository\nfatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\nFetch failed\n" },
  { view: 'tail', flags: ['--tail', '3'], range: '1-4 of 4', body: "fatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\nFetch failed\n" },
  { view: 'lines', flags: ['--lines', '0-3'], range: '0-3 of 4', body: "Fetching repository\nfatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\n" },
].flatMap(view => [
  { ...view, reader: 'inferred', command: ['job', 'stdout', '42'], label: 'job_stdout', rejectedUrl: 'https://scm.example/repo?token=CANARY-raw' },
  { ...view, reader: 'explicit', command: ['job', 'stdout', '42', '--type', 'project-update'], label: 'job_stdout', rejectedUrl: 'https://scm.example/repo?token=%43ANARY-encoded' },
  { ...view, reader: 'ad-hoc', command: ['ad-hoc', 'stdout', '42'], label: 'ad_hoc_stdout', rejectedUrl: "https://scm.example/repo?token='CANARY-apostrophe" },
]))('AWX $reader raw $view logs preserve ordinary URLs after SCM input validation (R3-R5)', async ({ command, flags, range, body, label, rejectedUrl }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], input: RunInput = {}) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
    try {
      const rejectedCreate = await run(['project', 'create', 'Synthetic SCM', '--scm-url', rejectedUrl, '--confirm'])
      expect(rejectedCreate.json(), rejectedCreate.body).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT', next: expect.stringContaining('--credential') } })
      expect(rejectedCreate.body).not.toContain('CANARY-')
      const rejectedEdit = await run(['project', 'edit', '42', '--scm-url', 'scm.txt', '--dry-run'], { files: [upload('scm.txt', rejectedUrl)] })
      expect(rejectedEdit.json(), rejectedEdit.body).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT', next: expect.stringContaining('--credential') } })
      expect(rejectedEdit.body).not.toContain('CANARY-')
      expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      const created = await run(['project', 'create', 'Synthetic SCM', '--scm-type', 'git', '--scm-url', 'https://scm.example/repo?ref=main', '--credential', '9', '--confirm'])
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      const synced = await run(['project', 'sync', '42', '--confirm', '--wait'])
      expect(synced.json(), synced.body).toMatchObject({ exitCode: 0 })
      allowWrites = false
      const response = await run([...command, ...flags])
      expect(response.json(), response.body).toMatchObject({ exitCode: 0, stderr: '' })
      expect(response.body).not.toContain('CANARY-')
      const stdout = response.json().stdout as string
      expect(decode(stdout.split('\nstdout:\n')[0])).toEqual({ [label]: { id: 42, lines: range } })
      expect(stdout).toContain(`\nstdout:\n${body}help[`)
      expect(stdout).toContain(`Run \`awx-axi ${command[0]} stdout 42 --lines 1-200\` to read from the start`)
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX project SCM URLs remain private on later project and activity reads (S8, R1)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec(`UPDATE tools SET enabled = 1, raw_api_mode = 'read-writes', raw_api_routes = '{"get":[],"write":["POST **","PUT **","PATCH **","DELETE **"]}',
        native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi';
      UPDATE role_tools SET raw_api = 1 WHERE role_id = 'synthetic-role' AND tool = 'awx-axi'`)
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      expect(call.args.join(' ')).not.toContain('CANARY-')
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['project', 'create', 'Synthetic SCM', '--scm-type', 'git', '--scm-url', 'scm.txt', '--scm-branch', 'main', '--credential', '9', '--confirm'],
        { files: [upload('scm.txt', 'https://scm.example/repo')] })
      await run(['project', 'edit', '42', '--scm-branch', 'updated', '--credential', '10', '--confirm'])
      expect(await run(['project', 'sync', '42', '--dry-run'])).toMatchObject({ dry_run: { action: 'sync', project: 42 } })
      expect(await run(['project', 'sync', '42', '--confirm', '--wait'])).toMatchObject({ job: { id: 42, project: 42, status: 'successful' } })
      allowWrites = false
      expect(await run(['project', 'show', '42'])).toMatchObject({ project: {
        name: 'Synthetic SCM', scm_type: 'git', scm_branch: 'updated', scm_url: '[SCM URL redacted]',
      } })
      expect(await run(['project', 'updates', '42'])).toMatchObject({ updates: [{ id: 42, status: 'successful' }] })
      const createdEvent = await run(['activity-stream', 'show', '1']) as { 'activity-stream': { changes: string } }
      expect(JSON.parse(createdEvent['activity-stream'].changes)).toEqual({ scm_url: '[SCM URL redacted]', name: 'Synthetic SCM' })
      allowWrites = true
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: {
        args: ['project', 'edit', '42', '--name', 'Recovered SCM', '--scm-url', 'https://scm.example/recovered', '--confirm'],
      } })
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi project list --limit 100') } })
      expect(interrupted.body).not.toContain('CANARY-')
      allowWrites = false
      expect(await run(['project', 'list', '--limit', '100'])).toMatchObject({ projects: [{ id: 42, name: 'Recovered SCM' }] })
      expect(await run(['project', 'show', '42'])).toMatchObject({ project: { name: 'Recovered SCM', scm_url: '[SCM URL redacted]' } })
      const editedEvent = await run(['activity-stream', 'show', '2']) as { 'activity-stream': { changes: string } }
      expect(JSON.parse(editedEvent['activity-stream'].changes)).toEqual({ scm_url: '[SCM URL redacted]', name: 'Recovered SCM' })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        method: 'PATCH', path: '/api/v2/projects/42/', body: { scm_branch: 'updated', credential: 10 },
      }))
      allowWrites = true
      await send('/__awx/write-outcome?drop=false', 'POST')
      await run(['project', 'edit', '42', '--scm-url', `https://scm.example/${'x'.repeat(1100)}`, '--confirm'])
      allowWrites = false
      expect(await run(['activity-stream', 'show', '3'])).toMatchObject({ 'activity-stream': { changes: '[activity changes redacted]' } })
      allowWrites = true
      const refused = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: {
        args: ['api', 'patch', 'projects/42/', '--body-file', 'body.json', '--confirm'],
        files: [upload('body.json', JSON.stringify({ scm_url: 'https://scm.example/repo?token=CANARY-rejected' }))],
      } })
      expect(refused.json()).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT' } })
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: 'localhost', port, path: '/api/v2/projects/42/', method: 'PATCH',
          ca: readFileSync(join(directory, 'ca.crt')), headers: { authorization: 'Bearer CANARY-awx-token', 'content-type': 'application/json' } }, response => {
          if (response.statusCode !== 200) { reject(new Error(`Unexpected fake controller status ${response.statusCode}`)); return }
          response.resume()
          response.on('end', resolve)
        })
        req.on('error', reject)
        req.end(JSON.stringify({ scm_url: 'https://scm.example/repo?token=CANARY-stored-url' }))
      })
      const rawBody = upload('body.json', JSON.stringify({ body: 12345, method: 'PATCH', path: 'projects/42/', hosts: [42], nested: { body: false, method: true, path: 98765 }, variables: 'internal_value: private-example',
        extra_vars: { label: 'private-label', code: 'private-code', action: 'private-action', type: 'private-type',
          status: 'private-status', would_send: 'private-would-send', help: 'private-help' } }))
      const preview = await run(['api', 'patch', 'projects/42/', '--body-file', 'body.json', '--dry-run'], { files: [rawBody] })
      expect(JSON.stringify(preview)).not.toContain('private-example')
      expect(preview).toMatchObject({ dry_run: { method: 'PATCH', path: 'projects/42/' } })
      const changed = await run(['api', 'patch', 'projects/42/', '--body-file', 'body.json', '--confirm'], { files: [rawBody] })
      expect(JSON.stringify(changed)).toContain('[SCM URL redacted]')
      expect(JSON.stringify(changed)).not.toContain('private-example')
      expect(JSON.stringify(changed)).not.toMatch(/private-(label|code|action|type|status|would-send|help)/)
      expect(changed).toMatchObject({ api_response: { method: 'PATCH', path: 'projects/42/', status: 200 } })
      const mask = `[structured input redacted, ${rawBody.size} bytes]`
      expect(changed).toMatchObject({ api_response: { body: { body: mask, method: mask, path: mask, hosts: [42],
        nested: { body: false, method: true, path: mask } } } })
      for (const args of [['api', 'get', 'projects/42/'], ['api', 'get', 'projects/'],
        ['api', 'post', 'projects/42/copy/', '--confirm']]) {
        expect(JSON.stringify(await run(args))).toContain('[SCM URL redacted]')
      }
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
configurationTests(['template'])
