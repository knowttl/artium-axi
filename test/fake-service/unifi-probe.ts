import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createUnifiAdapter } from '../../src/server/adapters/unifi.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import type { RunInput } from '../../src/shared/api.js'
import inventory from '../../tools/inventories/unifi-axi.json' with { type: 'json' }

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const origin = `https://localhost:${port}`, site = '22222222-2222-4222-8222-222222222222', existing = '11111111-1111-4111-8111-111111111111'
  const pem = readFileSync(join(directory, 'ca.crt'), 'utf8')
  const runner = await Runner.create(join(directory, 'calls'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'unifi.db'), provider), store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'unifi-axi'")
  store.replaceCredential('unifi-axi', { origin, siteId: site, apiKey: 'CANARY-unifi-key' }, 0, 'synthetic-development-user', Date.now())
  const reference = store.findCredential('unifi-axi')!
  db.prepare(`INSERT INTO trusted_certificates (id,credential_id,endpoint,fingerprint,leaf_fingerprint,pem,leaf_pem,mode,created_at,created_by)
    VALUES ('synthetic-ca', ?, ?, 'synthetic', 'synthetic', ?, ?, 'ca', ?, 'synthetic-development-user')`)
    .run(reference.id, origin + '/', pem, pem, Date.now())
  const log = join(directory, 'journal', 'writes.log')
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner,
    adapters: [createUnifiAdapter(new EmbeddedSecretSource(store), log)], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  try {
    const login = async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body); return response.json()
    }
    const session = await login(), headers = { authorization: `Bearer ${session.accessToken}` }
    const invoke = (args: string[], input: RunInput = {}, proof = headers) => app.inject({ method: 'POST', url: '/v1/tools/unifi-axi/run', headers: proof, payload: { ...input, args } })
    type Reply = { preview: { confirmation: string }, write: { outcome: string, target: string }, error?: { code: string } }
    const native = async (args: string[], input?: RunInput, proof = headers) => {
      const response = await invoke(args, input, proof)
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/opt\/tools|\/tmp\/artium/)
      return { code: response.json().exitCode as number, value: decode(response.json().stdout) as Reply }
    }
    const success = async (args: string[], input?: RunInput) => {
      const result = await native(args, input); assert.equal(result.code, 0, JSON.stringify(result)); return result.value
    }
    const grants = ['createNetwork', 'createNetwork:UNMANAGED', 'updateNetwork', 'updateNetwork:UNMANAGED', 'deleteNetwork']
    const policy = async (enabled: boolean, operations = grants) => {
      const auth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(auth.statusCode, 200, auth.body)
      const proof = { ...headers, 'x-artium-reauth-ticket': auth.json().ticket }
      const current = await app.inject({ url: '/v1/admin/tools/unifi-axi', headers: proof })
      assert.equal(current.statusCode, 200, current.body)
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/unifi-axi/write-access', headers: proof,
        payload: { enabled, operations, expectedRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const evidence = async () => JSON.parse(await send('/__unifi/evidence')) as { applied: number, attempts: number }
    const body = (name: string, vlanId: number) => ({ files: [{ name: 'private.json', contentBase64: Buffer.from(JSON.stringify({
      name, vlanId, management: 'UNMANAGED', enabled: true,
    })).toString('base64') }] })
    const create = ['network', 'create', '--body-file', 'private.json'], input = body('Private synthetic network', 42)
    const execute = (args: string[], confirmation: string, request: string) => [...args, '--execute', '--confirm', confirmation, '--request-id', request]
    await success(['network', 'list', '--full'])
    const offPreview = await success(create, input)
    assert.equal((await evidence()).applied, 0)
    assert.equal((await invoke(execute(create, offPreview.preview.confirmation, 'disabled'), input)).json().error.code, 'FLAG_BLOCKED')
    await policy(true, ['createNetwork'])
    const incomplete = await success(create, input)
    assert.equal((await native(execute(create, incomplete.preview.confirmation, 'missing-variant'), input)).value.error?.code, 'WRITE_DENIED')
    assert.equal((await evidence()).applied, 0)
    await policy(true)
    assert.equal((await native(execute(create, offPreview.preview.confirmation, 'old-revision'), input)).value.error?.code, 'CONFIRMATION_MISMATCH')
    const preview = await success(create, input)
    const other = { authorization: `Bearer ${(await login()).accessToken}` }
    assert.equal((await native(execute(create, preview.preview.confirmation, 'other-family'), input, other)).value.error?.code, 'CONFIRMATION_MISMATCH')
    const confirmed = execute(create, preview.preview.confirmation, 'create-once')
    const created = await success(confirmed, input)
    assert.equal(created.write.outcome, 'verified')
    assert.equal((await evidence()).applied, 1)
    await success(confirmed, input)
    assert.equal((await evidence()).applied, 1)
    await success(['write', 'show', '--request-id', 'create-once'])
    assert.equal((await native(['write', 'show', '--request-id', 'create-once'], undefined, other)).value.error?.code, 'WRITE_NOT_FOUND')
    assert.equal((await native(confirmed, body('Changed private payload', 42))).value.error?.code, 'WRITE_BINDING_MISMATCH')
    const update = ['network', 'update', '--network-id', existing, '--body-file', 'private.json'], replacement = body('Updated private network', 7)
    const stale = await success(update, replacement)
    await send('/__unifi/control?mode=drift')
    assert.equal((await native(execute(update, stale.preview.confirmation, 'drifted'), replacement)).value.error?.code, 'CONFIRMATION_MISMATCH')
    const lost = await success(update, replacement), lostArgs = execute(update, lost.preview.confirmation, 'lost-ack')
    await send('/__unifi/control?mode=drop')
    assert.equal((await native(lostArgs, replacement)).value.write.outcome, 'unknown')
    assert.equal((await evidence()).applied, 2)
    assert.equal((await native(['write', 'reconcile', '--request-id', 'lost-ack'])).value.write.outcome, 'unknown')
    assert.equal((await native(lostArgs, replacement)).value.write.outcome, 'unknown')
    assert.equal((await evidence()).applied, 2)
    const rejectedBody = body('Rejected private network', 7), rejected = await success(update, rejectedBody)
    await send('/__unifi/control?mode=reject')
    const rejectedArgs = execute(update, rejected.preview.confirmation, 'terminal-rejection')
    assert.equal((await native(rejectedArgs, rejectedBody)).value.write.outcome, 'rejected')
    const attempts = (await evidence()).attempts
    assert.equal((await native(rejectedArgs, rejectedBody)).value.write.outcome, 'rejected')
    assert.equal((await evidence()).attempts, attempts)
    const remove = ['network', 'delete', '--network-id', created.write.target], deletion = await success(remove)
    await success(execute(remove, deletion.preview.confirmation, 'delete-once'))
    assert.equal((await evidence()).applied, 3)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
    new SessionStore(address, sessionPath(process.platform, environment)).write(session)
    const path = join(directory, 'body.json')
    writeFileSync(path, JSON.stringify({ management: 'UNMANAGED', enabled: true, name: 'CLI private network', vlanId: 43 }), { mode: 0o600 })
    const cliArgs = ['network', 'create', '--body-file', path]
    const cli = await promisify(execFile)(process.execPath, ['/work/dist/cli/artium-axi.mjs', 'unifi-axi', ...cliArgs], { env: environment, timeout: 30000 })
    assert.doesNotMatch(cli.stdout + cli.stderr, /CANARY-|ARTIUM_SECRET_|\/tmp\//)
    const cliPreview = decode(cli.stdout) as Reply
    await success(execute(create, cliPreview.preview.confirmation, 'cli-upload'), body('CLI private network', 43))
    assert.equal((await evidence()).applied, 4)
    for (const route of inventory.commands.filter(route => route.effect === 'write')) await success([...route.command.split(' '), '--help'])
    for (const args of [['network', 'create', '--body-file', '/etc/passwd'], ['info', '--api-key', 'CANARY-caller'],
      ['hotspot', 'voucher', 'list', '--secret-output', '/tmp/result']]) assert.ok((await invoke(args)).statusCode >= 400)
    const old = await success(create, body('Later private network', 44))
    await policy(false)
    assert.equal((await invoke(execute(create, old.preview.confirmation, 'revoked'), body('Later private network', 44))).json().error.code, 'FLAG_BLOCKED')
    await policy(true)
    assert.equal((await native(execute(create, old.preview.confirmation, 'stale-revision'), body('Later private network', 44))).value.error?.code, 'CONFIRMATION_MISMATCH')
    db.prepare("DELETE FROM role_tools WHERE tool = 'unifi-axi'").run()
    assert.equal((await invoke(['info'])).statusCode, 403)
    const journal = readdirSync(log, { recursive: true }).filter(path => String(path).endsWith('.json'))
      .map(path => readFileSync(join(log, String(path)), 'utf8')).join('\n')
    assert.doesNotMatch(journal + JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-|private\.json|Private synthetic network|Updated private network|Rejected private network|CLI private network/)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    console.log(JSON.stringify({ unifi: '0.1.3', preview: 'native read without mutation', writes: 'exact base and variant grants, confirmation and stable request IDs',
      identity: 'caller/family/revision bound across isolated calls', recovery: 'unknown and rejected outcomes never resent', input: 'private JSON upload', cleanup: 'verified' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
