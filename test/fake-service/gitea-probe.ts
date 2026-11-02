import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createGiteaAdapter } from '../../src/server/adapters/gitea.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { toolInput } from '../../src/cli/input.js'
import type { RunInput } from '../../src/shared/api.js'

// Authenticated native probes run only inside the container with --network none.
assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const origin = `https://localhost:${port}`
  const pem = readFileSync(join(directory, 'ca.crt'), 'utf8')
  const runner = await Runner.create(join(directory, 'calls'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'gitea.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'gitea-axi'")
  store.replaceCredential('gitea-axi', { origin, tokenOrigin: origin, token: 'CANARY-gitea-token' }, 0, 'synthetic-development-user', Date.now())
  const reference = store.findCredential('gitea-axi')!
  db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
    VALUES ('synthetic-ca', ?, ?, 'synthetic', 'synthetic', ?, ?, 'ca', ?, 'synthetic-development-user')`).run(reference.id, origin + '/', pem, pem, Date.now())
  const log = join(directory, 'journal', 'writes.log')
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner,
    adapters: [createGiteaAdapter(new EmbeddedSecretSource(store), log)], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const invoke = (args: string[], input: RunInput = {}) => app.inject({ method: 'POST', url: '/v1/tools/gitea-axi/run', headers, payload: { ...input, args } })
    const policy = async (enabled: boolean, operations = ['issueEditIssue']) => {
      const auth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(auth.statusCode, 200, auth.body)
      const proof = { ...headers, 'x-artium-reauth-ticket': auth.json().ticket }
      const current = await app.inject({ url: '/v1/admin/tools/gitea-axi', headers: proof })
      assert.equal(current.statusCode, 200, current.body)
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/gitea-axi/write-access',
        headers: proof,
        payload: { enabled, operations, expectedRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().writeAccess.enabled, enabled)
    }
    const edit = ['issue', 'edit', '42', '--repo', 'example/project', '--title', 'Updated title', '--allow-write', 'issueEditIssue']
    const evidence = async () => JSON.parse(await send('/__evidence')) as { requests: Array<{ path: string, method: string, canaryReceived: boolean }> }
    const writes = async () => (await evidence()).requests.filter(row => row.method === 'PATCH').length
    const success = async (args: string[], input?: RunInput) => {
      const response = await invoke(args, input)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().exitCode, 0, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/opt\/tools|\/tmp\/artium/)
      return decode(response.json().stdout) as { confirmation: string }
    }
    const disabled = await invoke([...edit, '--preview'])
    assert.ok(disabled.statusCode >= 400, disabled.body)
    assert.equal((await evidence()).requests.length, 0)
    await policy(true)
    const body = join(directory, 'body.md')
    writeFileSync(body, 'Synthetic uploaded body')
    const upload = await toolInput('gitea-axi', [...edit, '--body-file', body, '--preview'])
    const preview = await success(upload.args, upload)
    assert.match(preview.confirmation, /^[a-f0-9-]{36}$/)
    assert.equal(await writes(), 0)
    const confirmed = { ...upload, args: [...upload.args.filter(arg => arg !== '--preview'), '--confirm', preview.confirmation] }
    await success(confirmed.args, confirmed)
    assert.equal(await writes(), 1)
    const replay = await invoke(confirmed.args, confirmed)
    assert.notEqual(replay.json().exitCode, 0, replay.body)
    assert.equal(await writes(), 1)
    const changed = [...edit, '--body-file', '-', '--preview']
    const stale = await success(changed, { stdin: 'Original explicit stdin' })
    const mismatch = await invoke([...changed.filter(arg => arg !== '--preview'), '--confirm', stale.confirmation], { stdin: 'Changed explicit stdin' })
    assert.notEqual(mismatch.json().exitCode, 0, mismatch.body)
    assert.equal(await writes(), 1)
    const raw = ['api', 'PATCH', 'repos/example/project/issues/42', '--raw-field', 'title=Raw metadata title', '--allow-write', 'issueEditIssue']
    const rawPreview = await success([...raw, '--preview'])
    await success([...raw, '--confirm', rawPreview.confirmation])
    assert.equal(await writes(), 2)
    const lostArgs = [...edit, '--body', 'Applied before lost reply']
    const lost = await success([...lostArgs, '--preview'])
    await send('/__gitea/drop-write')
    const uncertain = await invoke([...lostArgs, '--confirm', lost.confirmation])
    assert.equal(uncertain.statusCode, 200, uncertain.body)
    assert.notEqual(uncertain.json().exitCode, 0, uncertain.body)
    assert.match(uncertain.json().stdout + uncertain.json().stderr, /WRITE_OUTCOME_UNKNOWN/)
    assert.equal(await writes(), 3)
    await policy(false)
    await success(['write', 'reconcile', lost.confirmation])
    await policy(true)
    const retry = await invoke([...lostArgs, '--preview'])
    assert.notEqual(retry.json().exitCode, 0, retry.body)
    assert.equal(await writes(), 3)
    const before = (await evidence()).requests.length
    for (const args of [
      ['api', 'PUT', 'repos/example/project/actions/secrets/name', '--allow-write', 'updateRepoSecret', '--preview'],
      ['repo', 'create', 'example/project', '--source', '/tmp/local', '--allow-write', 'createCurrentUserRepo', '--preview'],
      [...edit, '--allow-write=issueCreateIssue', '--preview'],
    ]) assert.ok((await invoke(args)).statusCode >= 400)
    assert.equal((await evidence()).requests.length, before)
    db.prepare("DELETE FROM role_tools WHERE tool = 'gitea-axi'").run()
    const denied = await invoke(['issue', 'view', '42', '--repo', 'example/project'])
    assert.equal(denied.statusCode, 403, denied.body)
    const recorded = (await evidence()).requests.filter(row => row.path.startsWith('/api/v1/'))
    assert.ok(recorded.every(row => row.canaryReceived))
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()) + readFileSync(log, 'utf8'), /CANARY-|Synthetic uploaded body|Applied before lost reply/)
    assert.ok(readdirSync(join(directory, 'journal', 'write-receipts')).length > 0)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    console.log(JSON.stringify({ gitea: '0.1.1', policy: 'admin default off with exact operations', preview: 'no mutations',
      confirmation: 'revision-bound across native processes', text: 'upload and explicit stdin', raw: 'classified metadata',
      recovery: 'lost reply reconciled without retry', custody: 'managed profiles, redacted audit', deny: 'verified' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
