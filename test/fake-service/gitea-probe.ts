import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
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
import { allowRawApi, seedToolUser } from '../fixtures/tokens.js'
import { toolInput } from '../../src/cli/input.js'
import type { RunInput } from '../../src/shared/api.js'
import { transferRoutesFor } from '../../src/shared/api.js'
import { transferTargetDigest } from '../../src/server/transfer.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'

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
  allowRawApi(db, 'gitea-axi')
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'gitea-axi'")
  store.replaceCredential('gitea-axi', { origin, tokenOrigin: origin, token: 'CANARY-gitea-token' }, 0, 'synthetic-development-user', Date.now())
  const reference = store.findCredential('gitea-axi')!
  db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
    VALUES ('synthetic-ca', ?, ?, 'synthetic', 'synthetic', ?, ?, 'ca', ?, 'synthetic-development-user')`).run(reference.id, origin + '/', pem, pem, Date.now())
  const log = join(directory, 'journal', 'writes.log')
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner,
    adapters: [createGiteaAdapter(new EmbeddedSecretSource(store), log)], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {} })
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
    await policy(true, ['updateRepoSecret', 'deleteRepoSecret', 'createRepoVariable', 'updateRepoVariable', 'deleteRepoVariable',
      'issueCreateIssueAttachment', 'gitea.issue.download', 'gitea.pr.download', 'gitea.release.download'])
    const protectedValue = 'CANARY-protected-gitea-value'
    const input = { files: [{ name: 'protected.txt', contentBase64: Buffer.from(protectedValue).toString('base64') }] }
    const setSecret = ['secret', 'set', 'SYNTHETIC', '--repo', 'example/project', '--input', 'protected.txt', '--allow-write', 'updateRepoSecret']
    const secretPreview = await success([...setSecret, '--preview'], input)
    await success([...setSecret, '--confirm', secretPreview.confirmation], input)
    const rawSecret = ['api', 'PUT', 'repos/example/project/actions/secrets/SECOND', '--input', '-', '--allow-write', 'updateRepoSecret']
    const jsonInput = { stdin: JSON.stringify({ data: protectedValue }) }
    const jsonPreview = await success([...rawSecret, '--preview'], jsonInput)
    await success([...rawSecret, '--confirm', jsonPreview.confirmation], jsonInput)
    const names = await invoke(['secret', 'list', '--repo', 'example/project'])
    assert.equal(names.json().exitCode, 0, names.body)
    assert.match(names.json().stdout, /SYNTHETIC/)
    assert.doesNotMatch(names.body, /CANARY-/)
    const setVariable = ['variable', 'set', 'SYNTHETIC', '--repo', 'example/project', '--body=', '--allow-write', 'createRepoVariable']
    const variablePreview = await success([...setVariable, '--preview'])
    await success([...setVariable, '--confirm', variablePreview.confirmation])
    const opaque = Buffer.from([0, 255, 128, 13, 10, 2])
    const binary = { files: [{ name: 'new.bin', contentBase64: opaque.toString('base64') }] }
    const uploadAsset = ['issue', 'upload', '42', '--repo', 'example/project', '--file', 'new.bin', '--allow-write', 'issueCreateIssueAttachment']
    const assetPreview = await success([...uploadAsset, '--preview'], binary)
    await success([...uploadAsset, '--confirm', assetPreview.confirmation], binary)
    const uploaded = JSON.parse(await send('/__evidence')) as { requests: Array<{ uploadedBase64?: string }> }
    assert.ok(uploaded.requests.some(row => row.uploadedBase64 === opaque.toString('base64')))
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const routes = transferRoutesFor('gitea-axi')
    const expected = Buffer.from([0, 255, 13, 10, 127, 1])
    const sha256 = createHash('sha256').update(expected).digest('hex')
    for (const [operation, selector] of [
      ['gitea.issue.download', 'example/project/42/77'], ['gitea.pr.download', 'example/project/42/77'],
      ['gitea.release.download', 'example/project/releases/v1+build/77'],
    ]) {
      const selection = { operation, selector, type: 'attachment' }
      const request = { selection, targetDigest: transferTargetDigest(join(directory, 'saved.bin')) }
      const count = (await evidence()).requests.length
      const preview = await app.inject({ method: 'POST', url: routes.prepare.path, headers: proof, payload: request })
      assert.equal(preview.statusCode, 200, preview.body)
      assert.equal((await evidence()).requests.length, count)
      const transfer = { ...request, transferId: preview.json().transferId }
      const execute = await app.inject({ method: 'POST', url: routes.execute.path, headers: proof,
        payload: { ...transfer, execute: true, confirm: preview.json().confirm } })
      assert.equal(execute.statusCode, 200, execute.body)
      assert.deepEqual(execute.json().archive, { archiveBytes: expected.length, archiveSha256: sha256 })
      const received = await app.inject({ method: 'POST', url: routes.retrieve.path, headers: proof, payload: transfer })
      assert.equal(received.statusCode, 200, received.body)
      assert.deepEqual(received.rawPayload, expected)
      const replay = await app.inject({ method: 'POST', url: routes.retrieve.path, headers: proof, payload: transfer })
      assert.notEqual(replay.statusCode, 200, replay.body)
      const receipt = await app.inject({ method: 'POST', url: routes.receipt.path, headers: proof,
        payload: { ...transfer, archive: execute.json().archive, saveOutcome: 'verified-save' } })
      assert.equal(receipt.statusCode, 204, receipt.body)
    }
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: serverUrl, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
    const clientLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(clientLogin.statusCode, 200, clientLogin.body)
    new SessionStore(serverUrl, sessionPath(process.platform, environment)).write(clientLogin.json())
    const destinationDirectory = join(directory, 'saved')
    mkdirSync(destinationDirectory, { mode: 0o700 })
    const destination = join(destinationDirectory, 'attachment.bin')
    const cliArgs = ['download', '--operation', 'gitea.release.download', '--selector', 'example/project/releases/v1+build/77',
      '--type', 'attachment', '--destination', destination, '--password-stdin']
    const cli = (args: string[]) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['/work/dist/cli/artium-axi.mjs', ...args], { env: environment, stdio: 'pipe' })
      let output = ''; let error = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { error += chunk })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${code}: ${output} ${error}`)))
      child.stdin.end('CANARY-local-password\n')
    })
    const previewOutput = await cli(cliArgs)
    const { transferId, confirm: confirmation } = decode(previewOutput) as { transferId: string, confirm: string }
    const saved = await cli([...cliArgs, '--transfer', transferId, '--execute', '--confirm', confirmation])
    assert.match(saved, /verified-save/)
    assert.deepEqual(readFileSync(destination), expected)
    const selected = { selection: { operation: 'gitea.issue.download', selector: 'example/project/42/77', type: 'attachment' },
      targetDigest: transferTargetDigest(join(directory, 'denied.bin')) }
    const withoutProof = await app.inject({ method: 'POST', url: routes.prepare.path, headers, payload: selected })
    assert.notEqual(withoutProof.statusCode, 200, withoutProof.body)
    const owned = await app.inject({ method: 'POST', url: routes.prepare.path, headers: proof, payload: selected })
    assert.equal(owned.statusCode, 200, owned.body)
    const clientSession = new SessionStore(serverUrl, sessionPath(process.platform, environment)).read()
    assert.equal(clientSession?.status, 'authenticated')
    const other = { authorization: `Bearer ${clientSession.accessToken}` }
    const unrelated = await app.inject({ method: 'POST', url: routes.status.path, headers: other,
      payload: { ...selected, transferId: owned.json().transferId } })
    assert.notEqual(unrelated.statusCode, 200, unrelated.body)
    const ownerStatus = await app.inject({ method: 'POST', url: routes.status.path, headers: proof,
      payload: { ...selected, transferId: owned.json().transferId } })
    assert.equal(ownerStatus.statusCode, 200, ownerStatus.body)
    const count = (await evidence()).requests.length
    const changedTarget = await app.inject({ method: 'POST', url: routes.execute.path, headers: proof,
      payload: { ...selected, targetDigest: 'a'.repeat(64), transferId: owned.json().transferId, execute: true, confirm: owned.json().confirm } })
    assert.notEqual(changedTarget.statusCode, 200, changedTarget.body)
    assert.equal((await evidence()).requests.length, count)
    const staleTransfer = await app.inject({ method: 'POST', url: routes.prepare.path, headers: proof, payload: selected })
    assert.equal(staleTransfer.statusCode, 200, staleTransfer.body)
    await policy(false)
    const staleExecute = await app.inject({ method: 'POST', url: routes.execute.path, headers: proof,
      payload: { ...selected, transferId: staleTransfer.json().transferId, execute: true, confirm: staleTransfer.json().confirm } })
    assert.notEqual(staleExecute.statusCode, 200, staleExecute.body)
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /protected\.txt/)
    db.prepare("DELETE FROM role_tools WHERE tool = 'gitea-axi'").run()
    const denied = await invoke(['issue', 'view', '42', '--repo', 'example/project'])
    assert.equal(denied.statusCode, 403, denied.body)
    const recorded = (await evidence()).requests.filter(row => row.path.startsWith('/api/v1/'))
    assert.ok(recorded.every(row => row.canaryReceived))
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()) + readFileSync(log, 'utf8'), /CANARY-|Synthetic uploaded body|Applied before lost reply/)
    assert.ok(readdirSync(join(directory, 'journal', 'write-receipts')).length > 0)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    console.log(JSON.stringify({ gitea: '0.1.4', policy: 'admin default off with exact operations', preview: 'no mutations',
      confirmation: 'revision-bound across native processes', text: 'upload and explicit stdin', raw: 'classified metadata',
      recovery: 'lost reply reconciled without retry', custody: 'managed profiles, redacted audit', deny: 'verified' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
