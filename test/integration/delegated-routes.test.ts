import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'

// Each registration must be reviewed here before a delegated session can reach it.
const classified = new Map<string, 'public' | 'denied'>()
function classify(methods: string, paths: string, policy: 'public' | 'denied') {
  for (const method of methods.split(' ')) for (const path of paths.trim().split(/\s+/)) {
    classified.set(`${method} ${path}`, policy)
    if (method === 'GET') classified.set(`HEAD ${path}`, policy)
  }
}
classify('GET', `/ /login /auth/sso/:provider/start /auth/sso/:provider/callback /device
  /health/live /health/ready /cli/artium-axi.mjs /cli/artium-axi.mjs.sha256
  /admin/assets/confirm.js /admin/assets/style.css`, 'public')
classify('POST', `/login /logout /device /v1/auth/device /v1/auth/device/poll /v1/auth/login /v1/auth/delegated /v1/auth/refresh /v1/auth/logout /v1/tools/:tool/run`, 'public')
classify('POST', `/v1/ssh/prepare /v1/ssh/submit /v1/ssh/show /v1/ssh/list /v1/ssh/cancel
  /v1/ssh/connection/open /v1/ssh/connection/list /v1/ssh/connection/show /v1/ssh/connection/set /v1/ssh/connection/close`, 'public')
classify('GET', `/v1/tools /v1/skills /v1/me /v1/results/technitium-axi/:operation/:id /v1/results/awx-axi/:operation/:id
  /v1/results/kubernetes-axi/:operation/:id /v1/results/proxmox-axi/:operation/:id`, 'public')
classify('GET', `/account /password /reauth /v1/account/sessions
  /admin /admin/ssh /admin/ssh/credentials /admin/ssh/audit /admin/settings/sign-in
  /admin/settings/sign-in/:id /admin/settings/sign-in/:id/matches/:ruleId /admin/invitations
  /admin/audit /admin/tokens /admin/users /admin/users/:id /admin/roles /admin/roles/:id /admin/credentials /admin/tools /admin/tools/:tool
  /v1/account/tokens /v1/admin/tokens /v1/tools/proxmox-axi/streams/limits
  /v1/tools/kubernetes-axi/workspaces/:id /v1/tools/kubernetes-axi/workspaces/:id/files/*
  /v1/tools/kubernetes-axi/sessions /v1/tools/kubernetes-axi/sessions/:id
  /v1/tools/kubernetes-axi/sessions/:id/output /v1/tools/kubernetes-axi/sessions/:id/artifacts/*
  /v1/admin/tools /v1/admin/tools/:tool /v1/admin/tools/:tool/credential /v1/admin/tools/:tool/certificates
  /v1/admin/ssh/hosts /v1/admin/ssh/credentials /v1/admin/ssh/audit /v1/admin/ssh/audit/export
  /v1/admin/sso/providers /v1/admin/sso/providers/:id/credential /v1/admin/sso/role-rules /v1/admin/sso/invitations
  /v1/admin/audit /v1/admin/audit/export /v1/admin/users /v1/admin/users/:id /v1/admin/users/:id/sessions
  /v1/admin/roles /v1/admin/roles/:id /v1/admin/roles/:id/members`, 'denied')
classify('POST', `/password /reauth /v1/account/sessions/:sessionId/revoke /v1/account/sessions/revoke
  /v1/auth/reauth /v1/auth/password /v1/tools/proxmox-axi/streams /v1/tools/kubernetes-axi/workspaces
  /v1/account/tokens /v1/account/tokens/:id/revoke /v1/admin/tokens/:id/revoke /v1/admin/tokens/revoke-all
  /v1/tools/kubernetes-axi/sessions /v1/tools/kubernetes-axi/sessions/:id/confirm
  /v1/admin/tools/:tool/certificates/inspect /v1/admin/tools/:tool/certificates/trust
  /v1/admin/tools/gh-axi/device /v1/admin/tools/gh-axi/device/cancel /v1/admin/tools/gh-axi/device/poll
  /v1/admin/tools/:tool/test /v1/admin/ssh/hosts /v1/admin/ssh/binding /v1/admin/ssh/grant
  /v1/admin/ssh/credential /v1/admin/ssh/host-delete /v1/admin/ssh/credential-delete
  /v1/admin/sso/providers /v1/admin/sso/role-rules /v1/admin/sso/invitations
  /v1/admin/sso/invitations/:id/resend /v1/admin/sso/invitations/:id/revoke
  /v1/admin/users /v1/admin/users/:id/sessions/:sessionId/revoke /v1/admin/users/:id/sessions/revoke
  /v1/admin/users/:id/archive /v1/admin/users/:id/unlock /v1/admin/users/:id/password-reset /v1/admin/roles`, 'denied')
for (const tool of ['hybrid', 'checkpoint', 'mg', 'beyondtrust', 'gitea']) {
  classify('POST', ['prepare', 'execute', 'retrieve', 'receipt', 'cancel', 'status'].map(action => `/v1/transfers/${tool}/${action}`).join(' '), 'public')
}
classify('DELETE', `/v1/tools/proxmox-axi/streams/:id /v1/tools/kubernetes-axi/workspaces/:id
  /v1/tools/kubernetes-axi/sessions/:id /v1/admin/tools/:tool/certificates
  /v1/admin/sso/role-rules/:id /v1/admin/roles/:id`, 'denied')
classify('PUT', `/v1/admin/tools/awx-axi/origin /v1/admin/tools/:tool/credential /v1/admin/users/:id/roles
  /v1/admin/roles/:id/tools /v1/tools/kubernetes-axi/workspaces/:id/files/*`, 'denied')
classify('PATCH', `/v1/admin/token-settings /v1/admin/tools/:tool/write-access /v1/admin/tools/:tool /v1/admin/tools/:tool/credential
  /v1/admin/sso/providers/:id/activation /v1/admin/sso/providers/:id /v1/admin/sso/providers/:id/credential
  /v1/admin/sso/role-rules/:id /v1/admin/users/:id /v1/admin/roles/:id`, 'denied')
classify('GET', `/v1/admin/tools/:tool/instances /v1/admin/tools/:tool/instances/:name
  /v1/admin/tools/:tool/instances/:name/certificates`, 'denied')
classify('POST', `/v1/admin/tools/:tool/instances /v1/admin/tools/:tool/instances/:name/test
  /v1/admin/tools/:tool/instances/:name/certificates/inspect /v1/admin/tools/:tool/instances/:name/certificates/trust`, 'denied')
classify('PATCH', `/v1/admin/tools/:tool/instances/:name /v1/admin/tools/:tool/instances/:name/credential`, 'denied')
classify('PUT', '/v1/admin/tools/:tool/instances/:name/credential', 'denied')
classify('DELETE', '/v1/admin/tools/:tool/instances/:name /v1/admin/tools/:tool/instances/:name/certificates', 'denied')
classify('GET', `/v1/tools/kubernetes-axi/workspaces/:id /v1/tools/kubernetes-axi/workspaces/:id/files/*
  /v1/tools/kubernetes-axi/sessions /v1/tools/kubernetes-axi/sessions/:id
  /v1/tools/kubernetes-axi/sessions/:id/output /v1/tools/kubernetes-axi/sessions/:id/artifacts/*`, 'public')
classify('POST', `/v1/tools/kubernetes-axi/workspaces /v1/tools/kubernetes-axi/sessions
  /v1/tools/kubernetes-axi/sessions/:id/confirm`, 'public')
classify('DELETE', `/v1/tools/kubernetes-axi/workspaces/:id /v1/tools/kubernetes-axi/sessions/:id`, 'public')
classify('PUT', '/v1/tools/kubernetes-axi/workspaces/:id/files/*', 'public')
classify('GET', '/v1/tools/proxmox-axi/streams/limits', 'public')
classify('POST', '/v1/tools/proxmox-axi/streams', 'public')
classify('DELETE', '/v1/tools/proxmox-axi/streams/:id', 'public')

test('administrator-created delegated sessions cannot use admin, reauthentication or password routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-delegated-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1 WHERE id = 'synthetic-development-user'")
  const token = issueTestAccessToken(db, 'synthetic-development-user')
  const browser = createBrowserSession(db, 'synthetic-development-user', 'synthetic-csrf')
  const now = Date.now()
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-development-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 60000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  const registered: string[] = []
  const app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')),
    onRoute: (method, url) => { for (const item of Array.isArray(method) ? method : [method]) registered.push(`${item} ${url}`) },
    resolver: new SharedIdentityResolver(store), credentialStore: store, sshHosts: new SshHosts(db, provider),
    sshExecution: { provider, writeLog: join(directory, 'writes.log'), executable: join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js') },
    adapters: [await createKubernetesAdapter(new EmbeddedSecretSource(store), join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests')),
      createProxmoxAdapter(new EmbeddedSecretSource(store))], environment: {} })
  try {
    await app.ready()
    expect([...new Set(registered)].sort()).toEqual([...classified.keys()].sort())
    for (const route of registered) {
      if (classified.get(route) === 'public') continue
      const [method, template] = route.split(' ') as [string, string]
      const path = template.replace(':tool', 'kubernetes-axi').replace(':operation', 'token-create')
        .replace(/:[^/]+/g, 'synthetic').replace('*', 'synthetic')
      const selections = {
        hybrid: { operation: 'hash-download-bin', selector: 'a'.repeat(64), type: 'bin' },
        checkpoint: { operation: 'email.download', selector: 'synthetic-email', type: 'email' },
        mg: { operation: 'mail.message.export', selector: 'synthetic@example.test/message', type: 'mime' },
        beyondtrust: { operation: 'api-definition.download', selector: 'api', type: 'yaml' },
        gitea: { operation: 'gitea.release.download', selector: 'synthetic/repository/v1/1', type: 'attachment' },
      }
      const transfer = /^\/v1\/transfers\/(hybrid|checkpoint|mg|beyondtrust|gitea)\/(\w+)$/.exec(path)
      const payload = transfer ? {
        selection: selections[transfer[1] as keyof typeof selections], targetDigest: 'b'.repeat(64),
        ...(transfer[2] === 'prepare' ? {} : { transferId: '00000000-0000-4000-8000-000000000001' }),
        ...(transfer[2] === 'execute' ? { execute: true, confirm: 'synthetic-confirmation' } : {}),
        ...(transfer[2] === 'receipt' ? { archive: { archiveBytes: 1, archiveSha256: 'c'.repeat(64) }, saveOutcome: 'verified-save' } : {}),
      } : template === '/v1/tools/:tool/run' ? { args: ['--help'] } : {}
      const response = await app.inject({ method: method as 'GET', url: path,
        headers: { authorization: `Bearer ${token}`, cookie: `artium-session=${browser.id}`,
          host: 'synthetic.test', origin: 'http://synthetic.test' },
        ...(['GET', 'HEAD'].includes(method) ? {} : { payload }) })
      expect(response.statusCode, route).toBeGreaterThanOrEqual(300)
      expect(response.statusCode, route).toBeLessThan(500)
      if (path.startsWith('/v1/')) {
        expect(response.statusCode, route).toBe(403)
        if (method !== 'HEAD') expect(response.json().error.code, route).toBe('DELEGATED_SCOPE_DENIED')
      }
    }
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
    for (const path of ['/v1/tools/kubernetes-axi/sessions/00000000-0000-0000-0000-000000000000/tunnel',
      '/v1/tools/proxmox-axi/streams/00000000-0000-0000-0000-000000000000/pipe']) {
      const cursor = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit').get() as { id: number }).id
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const call = request({ host: '127.0.0.1', port: address.port, path, headers: { authorization: `Bearer ${token}`,
          connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
          'sec-websocket-key': Buffer.alloc(16).toString('base64') } })
        call.on('response', response => { response.resume(); resolve(response.statusCode) })
        call.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Unexpected upgrade')) })
        call.on('error', reject)
        call.end()
      })
      expect(status, path).toBe(403)
      const tool = path.includes('kubernetes-axi') ? 'kubernetes-axi' : 'proxmox-axi'
      expect(db.prepare('SELECT event, outcome FROM audit WHERE tool = ? AND id > ? ORDER BY id').all(tool, cursor), path)
        .toEqual([{ event: 'denial', outcome: 'TOOL_DISABLED' }])
    }
  } finally {
    await app.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
