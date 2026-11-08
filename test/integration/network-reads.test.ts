import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createUnifiAdapter } from '../../src/server/adapters/unifi.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { createGiteaAdapter } from '../../src/server/adapters/gitea.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths, toolSkillPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { SessionStore } from '../../src/cli/session.js'
import { copyClientInput } from '../fixtures/client-inputs.js'
import { allowRawApi, issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

const cases = [
  { tool: 'unifi-axi', args: ['info'], version: '10.6.109', path: '/proxy/network/integration/v1/info',
    executable: 'dist/bin.js', skill: 'dist/SKILL.md', secret: 'CANARY-unifi-key' },
  { tool: 'proxmox-axi', args: ['get', '/version'], version: '9.2.0', path: '/api2/json/version',
    executable: 'bin/proxmox-axi.mjs', skill: 'README.md', secret: 'CANARY-proxmox-token' },
  { tool: 'gitea-axi', args: ['api', 'version'], version: '1.23.4', path: '/api/v1/version',
    executable: 'dist/cli.js', skill: 'generated/SKILL.md', secret: 'CANARY-gitea-token' },
] as const
type Case = typeof cases[number]

// Background health reads must not race request evidence or runner cleanup assertions.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

async function withTool(item: Case, check: (fixture: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, headers: { authorization: string },
  cli: (args: string[]) => Promise<{ stdout: string, stderr: string }>, directory: string,
  evidence: () => Promise<{ requests: { method: string, path: string, canaryReceived: boolean }[] }>,
}) => Promise<void>) {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    allowRawApi(db, item.tool)
    const store = createCredentialStore(db, provider)
    const origin = `https://localhost:${port}`
    store.replaceCredential(item.tool, item.tool === 'unifi-axi' ? { origin, apiKey: item.secret }
      : item.tool === 'gitea-axi' ? { origin, tokenOrigin: origin, token: item.secret }
      : { origin, auth: 'api-token', tokenId: 'reader@pve!automation', token: item.secret,
        caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') }, 0, 'synthetic-development-user', Date.now())
    db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(item.tool)
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const previous = toolPaths[item.tool]
    const previousSkill = toolSkillPaths[item.tool]
    Object.assign(toolPaths, { [item.tool]: join(process.cwd(), 'tools/node_modules/@knowttl', item.tool, item.executable) })
    Object.assign(toolSkillPaths, { [item.tool]: join(process.cwd(), 'tools/node_modules/@knowttl', item.tool, item.skill) })
    const app = createApp({ db, runner, audit: new Audit(db), environment: {}, credentialStore: store,
      resolver: new SharedIdentityResolver(store), adapters: [item.tool === 'gitea-axi' ? createGiteaAdapter(new EmbeddedSecretSource(store))
        : item.tool === 'unifi-axi' ? createUnifiAdapter(new EmbeddedSecretSource(store)) : createProxmoxAdapter(new EmbeddedSecretSource(store))] })
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated',
        accessToken: token, refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000,
        familyExpiresAt: Date.now() + 43_200_000 })
      await check({ app, db, directory, headers: { authorization: `Bearer ${token}` },
        cli: args => promisify(execFile)(process.execPath, [bundle, ...args], { timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }),
        evidence: async () => JSON.parse(await send('/__evidence')) })
    } finally {
      await app.close()
      db.close()
      Object.assign(toolPaths, { [item.tool]: previous })
      Object.assign(toolSkillPaths, { [item.tool]: previousSkill })
    }
  })
}

test.each(cases)('$tool reads through the installed public client with managed credentials and trust', async item => {
  await withTool(item, async ({ cli, evidence, directory, app, headers, db }) => {
    const result = await cli([item.tool, ...item.args])
    expect(result.stdout).toContain(item.version)
    expect(result.stderr).toBe('')
    expect(await evidence()).toMatchObject({ requests: [{ method: 'GET', path: item.path, canaryReceived: true }] })
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
    const tools = (await app.inject({ url: '/v1/tools', headers })).json().tools
    expect(tools).toMatchObject([{ name: item.tool, readOnly: true }])
    expect((await cli(['tools', 'show', item.tool])).stdout).toContain(`artium-axi ${item.tool}`)
    expect((await cli([item.tool, ...item.args, '--help'])).stdout).toContain('help')
    expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(item.secret)
  })
})

test.each([
  ['get', '/version'], ['post', '/nodes/{node}/qemu'], ['put', '/access/acl'], ['delete', '/access/domains/{realm}'],
].flatMap(words => [
  { words, format: 'toon', parse: decode }, { words, format: 'json', parse: JSON.parse },
]))('Proxmox schema $words help retains request context in $format', async ({ words, format, parse }) => {
  await withTool(cases[1], async ({ cli, evidence }) => {
    const result = await cli(['proxmox-axi', 'schema', ...words, '--help', '--format', format])
    const document = parse(result.stdout) as { command: string, usage: string, flags: Record<string, string>, examples: string[] }
    const command = `artium-axi proxmox-axi schema ${words.join(' ')}`
    expect(document.command).toBe(command)
    expect(document.usage).toBe(`${command} [flags]`)
    expect(document.flags).toEqual({ catalogue: 'value', format: 'value', help: 'boolean', offset: 'value', view: 'value' })
    expect(document.examples).toEqual([`${command} --help`])
    expect((await evidence()).requests).toEqual([])
  })
})

test.each(cases)('$tool enforces current role and enablement before forwarding', async item => {
  await withTool(item, async ({ app, db, headers, evidence }) => {
    db.prepare('DELETE FROM role_tools WHERE tool = ?').run(item.tool)
    const denied = await app.inject({ method: 'POST', url: `/v1/tools/${item.tool}/run`, headers, payload: { args: [...item.args] } })
    expect(denied.json().error.code).toBe('TOOL_NOT_GRANTED')
    db.prepare('INSERT INTO role_tools (role_id, tool) VALUES (?, ?)').run('synthetic-role', item.tool)
    db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run(item.tool)
    const disabled = await app.inject({ method: 'POST', url: `/v1/tools/${item.tool}/run`, headers, payload: { args: [...item.args] } })
    expect(disabled.json().error.code).toBe('TOOL_DISABLED')
    expect((await evidence()).requests).toEqual([])
  })
})

test.each(cases)('$tool refuses credential overrides and writes before forwarding', async item => {
  await withTool(item, async ({ app, headers, evidence }) => {
    const override = await app.inject({ method: 'POST', url: `/v1/tools/${item.tool}/run`, headers,
      payload: { args: [...item.args, '--profile=another'] } })
    expect(override.json().error.code).toBe('FLAG_BLOCKED')
    const args = item.tool === 'gitea-axi'
      ? ['issue', 'edit', '42', '--repo', 'example/project', '--title', 'Synthetic update', '--allow-write', 'issueEditIssue', '--preview']
      : ['create', '/nodes', '--confirm', 'synthetic']
    const write = await app.inject({ method: 'POST', url: `/v1/tools/${item.tool}/run`, headers, payload: { args } })
    expect(write.json().error.code).toBe(item.tool === 'gitea-axi' ? 'FLAG_BLOCKED' : 'INVALID_INPUT')
    expect((await evidence()).requests).toEqual([])
  })
})

test('Gitea named item reads preserve selectors and redact upstream secret fields', async () => {
  await withTool(cases[2], async ({ cli, evidence }) => {
    const result = await cli(['gitea-axi', 'issue', 'view', '42', '-R', 'example/project', '--full'])
    expect(result.stdout).toContain('Synthetic issue')
    expect(result.stdout).not.toContain('CANARY-upstream-token')
    expect((await evidence()).requests).toEqual([{ method: 'GET', path: '/api/v1/repos/example/project/issues/42', canaryReceived: true }])
  })
})

test.each([
  ['api', 'POST', 'repos/example/project/issues'], ['api', 'user/tokens'], ['api', 'admin/users'],
  ['api', 'repos/example/project/raw/main/private.txt'], ['api', 'repos/example/project?token=CANARY-forbidden'],
  ['api', 'https://other.invalid/api/v1/version'], ['api', 'repos/example%2fproject'],
  ['issue', 'view', '42', '--repo', 'example/project', '--hostname', 'other.invalid'],
  ['issue', 'download', '42', '--repo', 'example/project'], ['workflow', 'list', '--repo', 'example/project'],
].map(args => ({ args })))('Gitea refuses $args before vendor forwarding', async ({ args }) => {
  await withTool(cases[2], async ({ app, headers, evidence }) => {
    const result = await app.inject({ method: 'POST', url: '/v1/tools/gitea-axi/run', headers, payload: { args } })
    expect(result.statusCode).toBe(400)
    expect((await evidence()).requests).toEqual([])
  })
})
