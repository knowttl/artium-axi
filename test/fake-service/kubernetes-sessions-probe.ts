import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { withFakeService } from './fixture.js'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { kubernetesSessionKind } from '../../src/shared/kubernetes.js'
import type { z } from 'zod'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import { createTestClientCertificate } from './certificates.mjs'
import { openKubernetesTunnel } from '../../src/cli/kubernetes-tunnel.js'
import { toolPaths } from '../../src/server/config.js'

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
const nativeCodec = await import(pathToFileURL(createRequire(realpathSync(toolPaths['kubernetes-axi'])).resolve('@toon-format/toon')).href) as { decode: (text: string) => unknown }
await withFakeService(async ({ directory, port, send }) => {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  const db = openStore(join(directory, 'data', 'artium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator=1; UPDATE tools SET enabled=1 WHERE name='kubernetes-axi'")
  const credential = { origin: `https://localhost:${port}`, auth: 'token', namespace: 'synthetic',
    certificateAuthority: 'no native trust', token: 'CANARY-kubernetes-token' }
  store.replaceCredential('kubernetes-axi', credential, 0, 'synthetic-development-user', Date.now())
  const reference = store.findCredential('kubernetes-axi')!
  const ca = readFileSync(join(directory, 'ca.crt'), 'utf8')
  db.prepare(`INSERT INTO trusted_certificates (id,credential_id,endpoint,fingerprint,leaf_fingerprint,pem,leaf_pem,mode,created_at,created_by)
    VALUES ('synthetic-ca', ?, ?, 'synthetic', 'synthetic', ?, ?, 'ca', ?, 'synthetic-development-user')`)
    .run(reference.id, credential.origin + '/', ca, ca, Date.now())
  const runner = await Runner.create(join(directory, 'calls'))
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(store), undefined, join(directory, 'requests'))
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, credentialStore: store,
    resolver: new SharedIdentityResolver(store), adapters: [adapter], environment: {} })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const request = (url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', payload?: Record<string, unknown>) => app.inject({ url, method, headers, payload })
    const prefix = '/v1/tools/kubernetes-axi/sessions'
    const reauth = await request('/v1/auth/reauth', 'POST', { password: 'CANARY-local-password' })
    assert.equal(reauth.statusCode, 200, reauth.body)
    const policy = async (allowWrites: boolean, grants = [...kubernetesSessionKind.options], acquireCredential = false) => {
      const detail = await app.inject({ url: '/v1/admin/tools/kubernetes-axi', headers: {
        ...headers, 'x-artium-reauth-ticket': reauth.json().ticket,
      } })
      assert.equal(detail.statusCode, 200, detail.body)
      const response = await app.inject({ url: '/v1/admin/tools/kubernetes-axi', method: 'PATCH',
        headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: {
          expectedRevision: detail.json().revision, nativeSettings: { allowWrites, acquireCredential, sessions: { grants: { 'synthetic-development-user': grants } } },
        } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const start = async (kind: z.infer<typeof kubernetesSessionKind>, args: string[], extra = {}) => {
      const response = await request(prefix, 'POST', { kind, argv: ['watch', 'logs'].includes(kind) ? args : ['prepare', '--', ...args], ...extra })
      assert.equal(response.statusCode, 200, response.body)
      return response.json() as { id: string, state: string, preview?: { digest: string }, code?: string }
    }
    const show = async (id: string) => {
      const response = await request(`${prefix}/${id}?wait=true`)
      assert.equal(response.statusCode, 200, response.body)
      return response.json() as { id: string, state: string, exitCode: number, code?: string, artifacts?: { path: string, bytes: number, sha256: string }[] }
    }
    const confirm = async (session: Awaited<ReturnType<typeof start>>) => {
      assert.equal(session.state, 'prepared', JSON.stringify(session))
      const response = await request(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview!.digest })
      assert.equal(response.statusCode, 200, response.body)
      return show(session.id)
    }
    const output = async (id: string) => {
      const response = await request(`${prefix}/${id}/output?wait=true`)
      assert.equal(response.statusCode, 200, response.body)
      return response.json() as { state: string, chunks: { channel: string, base64: string }[] }
    }
    const cancel = async (id: string) => assert.equal((await request(`${prefix}/${id}`, 'DELETE')).statusCode, 204)
    await policy(false)
    assert.equal((await request(prefix, 'POST', { kind: 'exec', argv: ['prepare', '--', 'exec', 'synthetic-pod', '--', 'true'] })).json().error.code, 'FLAG_BLOCKED')
    const logs = await start('logs', ['logs', 'synthetic-pod', '--follow'])
    assert.equal((await show(logs.id)).state, 'exited')
    assert.match((await output(logs.id)).chunks.map(chunk => Buffer.from(chunk.base64, 'base64').toString()).join(''), /Synthetic pod log/)
    await cancel(logs.id)
    const watched = await start('watch', ['get', 'pods', '--watch-only'])
    assert.match((await output(watched.id)).chunks.map(chunk => Buffer.from(chunk.base64, 'base64').toString()).join(''), /synthetic-pod/)
    await cancel(watched.id)
    await policy(true)
    const ordinary = await start('exec', ['exec', 'synthetic-pod', '--', 'printf', 'synthetic'])
    assert.match(ordinary.preview!.digest, /^[a-f0-9]{64}$/)
    assert.match(JSON.stringify(ordinary), new RegExp(`session confirm ${ordinary.id} --digest`))
    const separateLogin = await request('/v1/auth/login', 'POST', { username: 'synthetic-user', password: 'CANARY-local-password' })
    const stranger = { authorization: `Bearer ${separateLogin.json().accessToken}` }
    assert.equal((await app.inject({ url: `${prefix}/${ordinary.id}`, headers: stranger })).statusCode, 404)
    assert.equal((await app.inject({ url: prefix, headers: stranger })).json().count, 0)
    assert.equal((await app.inject({ url: `${prefix}/${ordinary.id}/confirm`, method: 'POST', headers: stranger,
      payload: { digest: ordinary.preview!.digest } })).statusCode, 404)
    assert.equal((JSON.parse(await send('/__kubernetes/bytes')) as { opened: number }).opened, 0)
    const invalid = await request(`${prefix}/${ordinary.id}/confirm`, 'POST', { digest: '0'.repeat(64) })
    assert.equal(invalid.json().error.code, 'INVALID_INPUT')
    const result = await confirm(ordinary)
    const channels = await output(ordinary.id)
    const diagnostic = channels.chunks.filter(chunk => chunk.channel === 'stderr')
      .map(chunk => Buffer.from(chunk.base64, 'base64').toString().replace(/https?:\/\/[^\s"']+/g, '[endpoint]').replace(/[a-f0-9]{32,}/g, '[opaque]')).join('')
    assert.equal(result.state, 'exited', diagnostic); assert.equal(result.exitCode, 0)
    assert.equal(channels.chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64').toString()).join(''), 'synthetic-byte-result\n')
    assert.equal(channels.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => Buffer.from(chunk.base64, 'base64').toString()).join(''), 'synthetic-stderr\n')
    const beforeReplay = JSON.parse(await send('/__kubernetes/bytes')) as { opened: number }
    assert.equal((await request(`${prefix}/${ordinary.id}/confirm`, 'POST', { digest: ordinary.preview!.digest })).statusCode, 200)
    assert.equal((JSON.parse(await send('/__kubernetes/bytes')) as { opened: number }).opened, beforeReplay.opened)
    await cancel(ordinary.id)
    const hold = await start('exec', ['exec', 'synthetic-pod', '--', 'synthetic-hold'])
    assert.equal((await request(`${prefix}/${hold.id}/confirm`, 'POST', { digest: hold.preview!.digest })).statusCode, 200)
    const released = await output(hold.id)
    assert.equal(released.state, 'running')
    assert.equal(released.chunks.map(chunk => Buffer.from(chunk.base64, 'base64').toString()).join(''), 'safe-before-EOF\n')
    await cancel(hold.id)
    const secret = await start('exec', ['exec', 'synthetic-pod', '--', 'synthetic-secret'])
    const withheld = await confirm(secret)
    assert.equal(withheld.state, 'failed', JSON.stringify(withheld))
    assert.doesNotMatch(JSON.stringify(await output(secret.id)), /CANARY-kubernetes-token|Q0FOQVJZLWt1YmVybmV0ZXMtdG9rZW4=/)
    await cancel(secret.id)
    const remoteExit = await confirm(await start('exec', ['exec', 'synthetic-pod', '--', 'synthetic-exit']))
    assert.equal(remoteExit.exitCode, 7, JSON.stringify(remoteExit))
    await cancel(remoteExit.id)
    const bytes = Buffer.from([0, 255, 13, 10, 128, 1]), sha256 = createHash('sha256').update(bytes).digest('hex')
    const inline = await confirm(await start('exec', ['exec', 'synthetic-pod', '-i', '--', 'cat'], { stdinBase64: bytes.toString('base64') }))
    assert.equal(inline.state, 'exited', JSON.stringify(inline))
    assert.deepEqual(Buffer.concat((await output(inline.id)).chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64'))), bytes)
    await cancel(inline.id)
    const manifest = await request('/v1/tools/kubernetes-axi/workspaces', 'POST', { files: [{ path: 'input.bin', bytes: bytes.length, sha256 }] })
    assert.equal(manifest.statusCode, 200, manifest.body)
    const workspace = manifest.json().id as string
    const uploaded = await app.inject({ method: 'PUT', url: `/v1/tools/kubernetes-axi/workspaces/${workspace}/files/input.bin`,
      headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    const copied = await confirm(await start('cp', ['cp', 'workspace:input.bin', 'synthetic-pod:/tmp/input.bin'], { workspace }))
    assert.equal(copied.state, 'exited', JSON.stringify(copied))
    const peer = JSON.parse(await send('/__kubernetes/bytes')) as { uploads: { path: string, bytes: number, sha256: string }[] }
    assert.deepEqual(peer.uploads, [{ path: 'input.bin', bytes: bytes.length, sha256 }])
    await cancel(copied.id)
    const downloaded = await confirm(await start('cp', ['cp', 'synthetic-pod:/tmp/download.bin', 'artifact:copy.bin']))
    assert.equal(downloaded.state, 'exited', JSON.stringify(downloaded))
    assert.deepEqual(downloaded.artifacts, [{ path: 'copy.bin', bytes: bytes.length, sha256 }])
    const artifact = await request(`${prefix}/${downloaded.id}/artifacts/copy.bin`)
    assert.equal(artifact.statusCode, 200, artifact.body); assert.deepEqual(artifact.rawPayload, bytes)
    await cancel(downloaded.id)
    const stdin = await confirm(await start('exec', ['exec', 'synthetic-pod', '-i', '--', 'cat'], { inputArtifact: { workspace, path: 'input.bin' } }))
    assert.deepEqual(Buffer.concat((await output(stdin.id)).chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64'))), bytes)
    await cancel(stdin.id)
    const largeInput = Buffer.alloc(512 * 1024 + 1, 97)
    const largeWorkspace = await request('/v1/tools/kubernetes-axi/workspaces', 'POST', { files: [{ path: 'large.bin',
      bytes: largeInput.length, sha256: createHash('sha256').update(largeInput).digest('hex') }] })
    assert.equal(largeWorkspace.statusCode, 200, largeWorkspace.body)
    const largeId = largeWorkspace.json().id as string
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/tools/kubernetes-axi/workspaces/${largeId}/files/large.bin`,
      headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: largeInput })).statusCode, 200)
    const largeStdin = await confirm(await start('exec', ['exec', 'synthetic-pod', '-i', '--', 'cat'], {
      inputArtifact: { workspace: largeId, path: 'large.bin' },
    }))
    assert.equal(largeStdin.state, 'exited', JSON.stringify(largeStdin))
    assert.deepEqual(Buffer.concat((await output(largeStdin.id)).chunks.filter(chunk => chunk.channel === 'stdout')
      .map(chunk => Buffer.from(chunk.base64, 'base64'))), largeInput)
    await cancel(largeStdin.id)
    await request('/v1/tools/kubernetes-axi/workspaces/' + largeId, 'DELETE')
    const attached = await confirm(await start('attach', ['attach', 'synthetic-pod']))
    assert.equal(attached.state, 'exited', JSON.stringify(attached)); await cancel(attached.id)
    for (const kind of ['create', 'apply'] as const) {
      for (const [variant, flags] of [['-f', 'workspace:object.json'], ['-f=workspace:object.json'], ['-k=workspace:bundle']].entries()) {
        const manifest = Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap',
          metadata: { name: `synthetic-session-${kind}-${variant}`, namespace: 'synthetic' }, data: { mode: 'workspace' } }))
        const files = [
          { path: 'object.json', content: manifest },
          { path: 'bundle/object.json', content: manifest },
          { path: 'bundle/kustomization.yaml', content: Buffer.from('resources:\n  - object.json\n') },
        ]
        const staged = await request('/v1/tools/kubernetes-axi/workspaces', 'POST', {
          files: files.map(file => ({ path: file.path, bytes: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex') })),
        })
        assert.equal(staged.statusCode, 200, staged.body)
        const workspace = staged.json().id as string
        for (const file of files) assert.equal((await app.inject({ method: 'PUT', url: `/v1/tools/kubernetes-axi/workspaces/${workspace}/files/${file.path}`,
          headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: file.content })).statusCode, 200)
        const operation = await start(kind, [kind, ...flags, '--validate=false'], { workspace })
        const settled = await confirm(operation)
        assert.equal(settled.state, 'exited', JSON.stringify(settled))
        await cancel(operation.id)
        await request('/v1/tools/kubernetes-axi/workspaces/' + workspace, 'DELETE')
      }
    }
    const bounded = await confirm(await start('exec', ['exec', 'synthetic-pod', '--', 'true'], { limits: { outputBytes: 5 } }))
    const clipped = await request(`${prefix}/${bounded.id}/output`)
    assert.equal(clipped.json().truncated, true)
    assert.equal(clipped.json().chunks.reduce((total: number, chunk: { length: number }) => total + chunk.length, 0), 5)
    await cancel(bounded.id)
    const pending = await start('exec', ['exec', 'synthetic-pod', '--', 'true'])
    const beforeRevocation = (JSON.parse(await send('/__kubernetes/bytes')) as { opened: number }).opened
    await policy(false)
    assert.equal((await request(`${prefix}/${pending.id}/confirm`, 'POST', { digest: pending.preview!.digest })).statusCode, 404)
    assert.equal((JSON.parse(await send('/__kubernetes/bytes')) as { opened: number }).opened, beforeRevocation)
    await policy(true)
    const revoked = await start('exec', ['exec', 'synthetic-pod', '--', 'synthetic-hold'])
    await request(`${prefix}/${revoked.id}/confirm`, 'POST', { digest: revoked.preview!.digest }); await output(revoked.id)
    await policy(false)
    assert.equal((await request(`${prefix}/${revoked.id}`)).statusCode, 404)
    assert.deepEqual(readdirSync(join(directory, 'data', 'tool-logs', 'kubernetes-axi', 'byte-sessions')), [])
    await policy(true)
    const expiring = await start('exec', ['exec', 'synthetic-pod', '--', 'true'], { limits: { lifetimeSeconds: 30 } })
    const now = Date.now
    try {
      Date.now = () => now() + 31000
      assert.equal((await request(`${prefix}/${expiring.id}`)).json().error.code, 'TOKEN_EXPIRED')
    } finally { Date.now = now }
    const slots = []
    for (let index = 0; index < 4; index++) slots.push(await start('exec', ['exec', 'synthetic-pod', '--', 'true']))
    assert.equal((await request(prefix, 'POST', { kind: 'exec', argv: ['prepare', '--', 'exec', 'synthetic-pod', '--', 'true'] })).json().error.code, 'TOO_MANY_CALLS')
    await Promise.all(slots.map(session => cancel(session.id)))
    // Abrupt worker loss must also fence its real kubectl descendant before cleanup acknowledgement.
    const crashed = await start('exec', ['exec', 'synthetic-pod', '--', 'synthetic-hold'])
    await request(`${prefix}/${crashed.id}/confirm`, 'POST', { digest: crashed.preview!.digest }); await output(crashed.id)
    const children = (pid: number) => readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    const workers = children(process.pid).filter(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/dist/hosted-session.js'))
    assert.equal(workers.length, 1)
    const nativeChildren = children(workers[0])
    assert.ok(nativeChildren.length > 0)
    process.kill(workers[0], 'SIGKILL')
    assert.equal((await show(crashed.id)).state, 'failed')
    for (const pid of nativeChildren) {
      try { assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0], 'Z') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await cancel(crashed.id)
    // The bundled CLI drives the same owned endpoints and verified local artifact publication.
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1',
      XDG_STATE_HOME: join(directory, 'cli-state'), XDG_CONFIG_HOME: join(directory, 'cli-config'), HOME: join(directory, 'cli-home') }
    new SessionStore(address, sessionPath(process.platform, environment)).write(login.json())
    const cli = async <T extends object>(args: string[]): Promise<T> => {
      const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../cli/artium-axi.mjs', import.meta.url)), 'kubernetes-axi', ...args],
        { env: environment, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
      return JSON.parse(result.stdout) as T
    }
    const inputDirectory = join(directory, 'input-tree'), downloads = join(directory, 'downloads')
    mkdirSync(inputDirectory, { mode: 0o700 }); mkdirSync(downloads, { mode: 0o700 })
    writeFileSync(join(inputDirectory, 'input.bin'), bytes, { mode: 0o600 })
    const staged = await cli<{ id: string, ready: boolean }>(['workspace', 'create', inputDirectory, '--json'])
    assert.equal(staged.ready, true)
    await cli(['workspace', 'download', staged.id, 'input.bin', '--output', join(downloads, 'workspace.bin'), '--json'])
    assert.deepEqual(readFileSync(join(downloads, 'workspace.bin')), bytes)
    const cliSession = await cli<{ id: string, preview: { digest: string } }>(['session', 'start', 'cp', '--json', '--', 'cp', 'synthetic-pod:/tmp/download.bin', 'artifact:cli.bin'])
    assert.ok((await cli<{ sessions: { id: string }[] }>(['session', 'list', '--json'])).sessions.some(session => session.id === cliSession.id))
    await cli(['session', 'confirm', cliSession.id, '--digest', cliSession.preview.digest, '--json'])
    assert.equal((await cli<{ state: string }>(['session', 'show', cliSession.id, '--wait', '--json'])).state, 'exited')
    await cli(['session', 'artifact', cliSession.id, 'cli.bin', '--output', join(downloads, 'artifact.bin'), '--json'])
    assert.deepEqual(readFileSync(join(downloads, 'artifact.bin')), bytes)
    await cli(['session', 'cancel', cliSession.id, '--confirm', '--json'])
    await cli(['workspace', 'delete', staged.id, '--json'])
    await request('/v1/tools/kubernetes-axi/workspaces/' + workspace, 'DELETE')
    const echo = async (port: number, bytes: Buffer): Promise<Buffer> => {
      const socket = createConnection({ host: '127.0.0.1', port })
      const chunks: Buffer[] = []
      socket.setTimeout(10000, () => socket.destroy(new Error('Synthetic forwarded connection timed out')))
      try {
        return await new Promise<Buffer>((resolve, reject) => {
          socket.once('connect', () => socket.end(bytes))
          socket.on('data', (chunk: Buffer) => chunks.push(chunk))
          socket.once('end', () => resolve(Buffer.concat(chunks)))
          socket.once('error', reject)
        })
      } finally { socket.destroy() }
    }
    const forward = await start('port-forward', ['port-forward', 'synthetic-pod', '0:8080', '0:9090'])
    assert.equal((await request(`${prefix}/${forward.id}/confirm`, 'POST', { digest: forward.preview!.digest })).statusCode, 200)
    const ready = await request(`${prefix}/${forward.id}?wait=ready`)
    assert.equal(ready.statusCode, 200, ready.body)
    assert.deepEqual(ready.json().remotePorts, [8080, 9090]); assert.equal(ready.json().tunnelReady, true)
    const tunnel = await openKubernetesTunnel({ serverUrl: address, session: forward.id, ports: [8080, 9090],
      accessToken: login.json().accessToken, signal: new AbortController().signal })
    assert.deepEqual(await Promise.all(tunnel.ports.map(port => echo(port.local, bytes))), [bytes, bytes])
    const largeForward = Buffer.alloc(256 * 1024 + 1, 98)
    assert.deepEqual(await echo(tunnel.ports[0].local, largeForward), largeForward)
    await assert.rejects(openKubernetesTunnel({ serverUrl: address, session: forward.id, ports: [8080],
      accessToken: separateLogin.json().accessToken, signal: new AbortController().signal }))
    await assert.rejects(openKubernetesTunnel({ serverUrl: address, session: forward.id, ports: [4444],
      accessToken: login.json().accessToken, signal: new AbortController().signal }), { code: 'INVALID_INPUT' })
    assert.deepEqual(await echo(tunnel.ports[1].local, bytes), bytes)
    await policy(false)
    await tunnel.closed
    await assert.rejects(echo(tunnel.ports[0].local, bytes), { code: 'ECONNREFUSED' })
    assert.equal((await request(`${prefix}/${forward.id}`)).statusCode, 404)
    await policy(true)
    const lostForward = await start('port-forward', ['port-forward', 'synthetic-pod', '0:8080'])
    await request(`${prefix}/${lostForward.id}/confirm`, 'POST', { digest: lostForward.preview!.digest })
    await request(`${prefix}/${lostForward.id}?wait=ready`)
    const lostTunnel = await openKubernetesTunnel({ serverUrl: address, session: lostForward.id, ports: [8080],
      accessToken: login.json().accessToken, signal: new AbortController().signal })
    const forwardingWorkers = children(process.pid).filter(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/dist/hosted-session.js'))
    assert.equal(forwardingWorkers.length, 1)
    process.kill(forwardingWorkers[0], 'SIGKILL')
    assert.equal((await show(lostForward.id)).state, 'failed')
    await lostTunnel.closed
    await assert.rejects(echo(lostTunnel.ports[0].local, bytes), { code: 'ECONNREFUSED' })
    await cancel(lostForward.id)
    const cliForward = await start('port-forward', ['port-forward', 'synthetic-pod', '0:8080'])
    await request(`${prefix}/${cliForward.id}/confirm`, 'POST', { digest: cliForward.preview!.digest })
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli/artium-axi.mjs', import.meta.url)),
      'kubernetes-axi', 'tunnel', cliForward.id, '--port', '8080', '--json'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
    const terminal = once(child, 'close')
    const lines = createInterface({ input: child.stdout })
    try {
      const [line] = await once(lines, 'line')
      const connected = JSON.parse(line) as { ports: { local: number }[] }
      assert.deepEqual(await echo(connected.ports[0].local, bytes), bytes)
      child.kill('SIGINT')
      assert.equal((await terminal)[0], 0)
    } finally { lines.close(); child.kill('SIGKILL'); await terminal; await cancel(cliForward.id) }

    type NativeReply = { request: string, digest: string, complete?: boolean, replayed?: boolean, result?: { id: string, path: string } }
    const native = async (args: string[]) => {
      const response = await request('/v1/tools/kubernetes-axi/run', 'POST', { args })
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_/)
      return { code: response.json().exitCode as number, value: nativeCodec.decode(response.json().stdout) as NativeReply }
    }
    const nativeSuccess = async (args: string[]) => {
      const result = await native(args); assert.equal(result.code, 0, JSON.stringify(result)); return result.value
    }
    const acquisition = ['prepare', '--', 'create', 'token', 'synthetic-account', '--duration=600s']
    assert.equal((await request('/v1/tools/kubernetes-axi/run', 'POST', { args: acquisition })).json().error.code, 'FLAG_BLOCKED')
    await policy(true, [...kubernetesSessionKind.options], true)
    const tokenCount = async () => (JSON.parse(await send('/__kubernetes/credentials')) as { requests: number }).requests
    assert.notEqual((await native(['prepare', '--', 'create', 'token', 'synthetic-account', '--duration=3601s'])).code, 0)
    assert.equal(await tokenCount(), 0)
    const preparedToken = await nativeSuccess(acquisition)
    const tokenPreview = await nativeSuccess(['preview', preparedToken.request])
    assert.equal(await tokenCount(), 0)
    const confirmation = ['confirm', preparedToken.request, '--digest', tokenPreview.digest]
    const acquired = await nativeSuccess(confirmation)
    assert.ok(acquired.result)
    assert.equal(await tokenCount(), 1)
    assert.equal((await app.inject({ url: acquired.result.path, headers: stranger })).statusCode, 404)
    const invalidSink = await cli(['credential', acquired.result.id, '--credential-fd', '1', '--json']).catch(error => error as { code: number })
    assert.equal((invalidSink as { code: number }).code, 2)
    const delivered = spawn(process.execPath, [fileURLToPath(new URL('../../cli/artium-axi.mjs', import.meta.url)), 'kubernetes-axi',
      'credential', acquired.result.id, '--credential-fd', '5', '--json'], { env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe'], timeout: 30000 })
    const privateChunks: Buffer[] = [], publicChunks: Buffer[] = []
    const deliveryPipe = delivered.stdio.at(5) as Readable
    deliveryPipe.on('data', (chunk: Buffer) => privateChunks.push(chunk))
    delivered.stdout!.on('data', (chunk: Buffer) => publicChunks.push(chunk))
    delivered.stderr!.on('data', (chunk: Buffer) => publicChunks.push(chunk))
    assert.equal((await once(delivered, 'close'))[0], 0)
    assert.equal(Buffer.concat(privateChunks).toString(), 'CANARY-issued-kubernetes-token\n')
    assert.doesNotMatch(Buffer.concat(publicChunks).toString(), /CANARY-|ARTIUM_SECRET_/)
    assert.equal((await request(acquired.result.path)).statusCode, 404)
    assert.equal((await nativeSuccess(confirmation)).replayed, true)
    assert.equal(await tokenCount(), 1)
    const revokedToken = await nativeSuccess(acquisition)
    const revokedPreview = await nativeSuccess(['preview', revokedToken.request])
    const revokedResult = await nativeSuccess(['confirm', revokedToken.request, '--digest', revokedPreview.digest])
    assert.ok(revokedResult.result)
    await policy(true, [...kubernetesSessionKind.options], false)
    assert.equal((await request(revokedResult.result.path)).json().error.code, 'FLAG_BLOCKED')
    await policy(true, [...kubernetesSessionKind.options], true)
    assert.equal((await request(revokedResult.result.path)).statusCode, 404)
    await send('/__kubernetes/control?mode=credential-drop')
    const lostToken = await nativeSuccess(acquisition)
    const lostPreview = await nativeSuccess(['preview', lostToken.request])
    const lostConfirmation = ['confirm', lostToken.request, '--digest', lostPreview.digest]
    assert.notEqual((await native(lostConfirmation)).code, 0)
    const afterLost = await tokenCount()
    await native(lostConfirmation)
    assert.equal(await tokenCount(), afterLost)
    createTestClientCertificate(directory)
    const current = store.findCredential('kubernetes-axi')!
    store.replaceCredential('kubernetes-axi', { origin: credential.origin, auth: 'certificate', namespace: 'synthetic', certificateAuthority: 'no native trust',
      clientCertificate: readFileSync(join(directory, 'client.crt'), 'utf8'), privateKey: readFileSync(join(directory, 'client.key'), 'utf8') }, current.revision!, 'synthetic-development-user', Date.now())
    const certificate = await confirm(await start('exec', ['exec', 'synthetic-pod', '--', 'true']))
    assert.equal(certificate.state, 'exited', JSON.stringify(certificate)); await cancel(certificate.id)
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-|ARTIUM_SECRET_/)
    assert.deepEqual(readdirSync(join(directory, 'data', 'tool-logs', 'kubernetes-axi', 'byte-sessions')), [])
    console.log(JSON.stringify({ kubernetes: '0.1.3', sessions: 'one operation, explicit grants, native preview and exact confirmation',
      bytes: 'separate channels, binary copy and credential withholding before EOF', cleanup: 'worker profiles removed at settlement' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
