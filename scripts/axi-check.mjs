import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'
import { createTestCertificates } from '../test/fake-service/certificates.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
if (process.platform !== 'linux') {
  console.error(`axi-check: unverified on ${process.platform}; clean-install acceptance requires Linux, curl, sha256sum and Node >=24.11. Windows/macOS execution needs separate host verification.`)
  process.exit(1)
}
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' })
const { createApp } = await import('../dist/src/server/app.js')
const { openStore, createCredentialStore } = await import('../dist/src/server/store/db.js')
const { EnvironmentKeyProvider } = await import('../dist/src/server/store/key-provider.js')
const { Audit } = await import('../dist/src/server/audit/audit.js')
const { Runner } = await import('../dist/src/server/runner/runner.js')
const { createFalconAdapter } = await import('../dist/src/server/adapters/falcon.js')
const { SharedIdentityResolver } = await import('../dist/src/server/policy/identity-resolver.js')
const { seedToolUser } = await import('../dist/test/fixtures/tokens.js')
const { cliVersion } = await import('../dist/src/shared/version.js')
const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), 'artium-axi-check-'))
const started = performance.now()
let app
let server
let db
let runner
const pass = (number, principle) => console.log(`pass: ${number} ${principle} (script-visible checks)`)
try {
  const home = join(directory, 'home')
  const install = join(home, 'bin')
  mkdirSync(install, { recursive: true })
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
  db = openStore(join(directory, 'data', 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE users SET must_change = 1; UPDATE tools SET enabled = 1, pinned_version = '0.3.0' WHERE name = 'falcon-axi'")
  const store = createCredentialStore(db, key)
  const reference = store.replaceCredential('falcon-axi', { clientId: 'CANARY-check-client', clientSecret: 'CANARY-check-secret', region: 'us-2' }, 0, 'synthetic-development-user', Date.now())
  db.prepare("INSERT INTO tool_health (tool, status, checked_at, credential_revision, error_code) VALUES ('falcon-axi', 'ok', ?, ?, NULL)").run(Date.now(), reference.revision)
  runner = await Runner.create(join(directory, 'calls'))
  const adapter = createFalconAdapter({ getCredential: async ref => store.readCredential(ref) })
  const prepare = adapter.prepare.bind(adapter)
  const forwarded = []
  const upstream = 'detections[1]{id,status}:\n  synthetic-detection,open\nhelp[1]:\n  - Run `falcon-axi detection list --full`\n'
  adapter.prepare = async (args, ref) => {
    forwarded.push([...args])
    const prepared = await prepare(args, ref)
    const fakeArgs = args[0] === 'detection' && args[1] === 'list'
      ? ['print', args.includes('--full') ? 'detail: Synthetic full detail\n' : upstream] : [...args]
    return { ...prepared, executable: process.execPath, args: [join(root, 'test/fake-tool/fake-axi.mjs'), ...fakeArgs], limits: { timeoutMs: 5000 } }
  }
  app = createApp({ db, audit: new Audit(db), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  await app.ready()
  createTestCertificates(directory, ['localhost'])
  server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) }, async (request, reply) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const result = await app.inject({ method: request.method, url: request.url, headers: request.headers, payload: Buffer.concat(chunks) })
      reply.writeHead(result.statusCode, result.headers)
      reply.end(result.rawPayload)
    } catch {
      reply.writeHead(500)
      reply.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `https://localhost:${server.address().port}`
  const ca = join(directory, 'ca.crt')
  const env = { PATH: `${install}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: ca }
  const options = { cwd: install, env, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
  const downloaded = join(install, 'artium-axi.mjs')
  const checksumFile = join(install, 'artium-axi.mjs.sha256')
  for (const path of ['artium-axi.mjs', 'artium-axi.mjs.sha256']) {
    await execute('curl', ['--fail', '--silent', '--show-error', '--cacert', ca, '--output', path, `${url}/cli/${path}`], options)
  }
  const bytes = readFileSync(downloaded)
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(readFileSync(checksumFile, 'utf8'), `${digest}  artium-axi.mjs\n`)
  await execute('sha256sum', ['--check', 'artium-axi.mjs.sha256'], options)
  writeFileSync(downloaded, Buffer.concat([bytes, Buffer.from('\n// synthetic corruption\n')]))
  await assert.rejects(execute('sha256sum', ['--check', 'artium-axi.mjs.sha256'], options))
  writeFileSync(downloaded, bytes)
  const metadata = await app.inject({ url: '/cli/artium-axi.mjs', headers: { 'x-artium-cli-version': '0.0.0-old' } })
  assert.equal(metadata.statusCode, 200)
  assert.equal(metadata.headers['x-artium-cli-version'], cliVersion)
  assert.equal(metadata.headers['x-artium-cli-sha256'], digest)
  assert.match(metadata.headers['content-type'], /^text\/javascript/)
  assert.equal(metadata.headers['content-disposition'], 'attachment; filename="artium-axi.mjs"')
  assert.deepEqual(metadata.rawPayload, bytes)
  const binary = join(install, 'artium-axi')
  renameSync(downloaded, binary)
  chmodSync(binary, 0o755)
  rmSync(checksumFile)
  assert.deepEqual(readdirSync(install), ['artium-axi'])
  const cli = async (args, input) => {
    const child = execFile('artium-axi', args, options)
    const result = new Promise(resolve => {
      child.on('error', error => resolve({ code: error.code, stdout: '', stderr: error.message }))
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    child.stdin.end(input)
    return result
  }
  const success = async (args, input) => {
    const result = await cli(args, input)
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stdout} ${result.stderr}`)
    assert.equal(result.stderr, '')
    return result.stdout
  }
  for (const host of ['claude', 'codex', 'opencode', 'pi']) {
    const output = decode(await success(['setup', '--host', host, ...(host === 'claude' ? ['--hook'] : [])]))
    assert.equal(output.status, 'installed')
    assert.match(readFileSync(output.skill, 'utf8'), /Use artium-axi tools first/)
  }
  for (const host of ['codex', 'opencode', 'pi']) {
    const unsupported = await cli(['setup', '--host', host, '--hook'])
    assert.equal(unsupported.code, 2)
    assert.match(decode(unsupported.stdout).error.message, /unsupported.*no verified.*No files were written/)
  }
  const unknown = await cli(['setup', '--host', 'synthetic-unsupported'])
  assert.equal(unknown.code, 2)
  assert.match(decode(unknown.stdout).error.next, /claude\|codex\|opencode/)
  const login = await cli(['login', '--username', 'synthetic-user', '--password-stdin'], 'CANARY-local-password\n')
  assert.equal(login.code, 1)
  assert.equal(decode(login.stdout).error.code, 'PASSWORD_CHANGE_REQUIRED')
  await success(['passwd', '--password-stdin'], 'CANARY-check-new-password\n')
  await success(['login', '--username', 'synthetic-user', '--password-stdin'], 'CANARY-check-new-password\n')
  const first = await success(['falcon-axi', 'detection', 'list'])
  assert.equal(first, upstream.replace('`falcon-axi detection', '`artium-axi falcon-axi detection'))
  console.log(`distribution: Linux download, SHA-256 rejection of corruption, standalone launcher, setup, login, password change and first call passed; sha256=${digest}`)
  const toolsText = await success(['tools'])
  const tools = decode(toolsText)
  assert.deepEqual(tools.tools, [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }])
  decode(first)
  pass(1, 'Token-efficient output: TOON and upstream stream preservation')
  assert.deepEqual(Object.keys(tools.tools[0]), ['name', 'status', 'version'])
  const detail = decode(await success(['tools', 'show', 'falcon-axi']))
  assert.equal(detail.tool, 'falcon-axi')
  assert.ok(detail.commands.length > 0 && detail.upstreamHelp && detail.example)
  pass(2, 'Minimal default schemas: three fields with separate detail')
  assert.equal(await success(['falcon-axi', 'detection', 'list', '--full']), 'detail: Synthetic full detail\n')
  assert.deepEqual(forwarded.at(-1), ['detection', 'list', '--full'])
  for (const stream of ['stdout', 'stderr']) {
    const truncated = await cli(['falcon-axi', stream, String(4 * 1024 * 1024 + 1)])
    assert.equal(truncated.code, 0)
    assert.match(truncated.stderr, new RegExp(`^artium-axi: output truncated \\(${stream}\\)\\.\\n`))
    assert.equal(stream === 'stdout' ? truncated.stdout.length : truncated.stderr.split('\n')[1].length, 4 * 1024 * 1024)
  }
  pass(3, 'Content truncation: --full forwarded, both 4 MiB stream caps disclosed')
  const homeText = await success([])
  const homeView = decode(homeText)
  assert.equal(homeView.tools.length, 1)
  const doctor = await success(['doctor'])
  assert.deepEqual(doctor.trim().split('\n'), ['pass: server address', 'pass: certificate', 'pass: token', 'pass: CLI version', 'pass: falcon-axi (ok)'])
  pass(4, 'Pre-computed aggregates: counted views and doctor checks')
  db.exec('DELETE FROM user_roles')
  const empty = decode(await success(['tools']))
  assert.equal(empty.tools, '0 available')
  assert.ok(empty.reason && empty.contact)
  db.exec("INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-development-user', 'synthetic-role')")
  pass(5, 'Definitive empty states: zero with reason and administrator contact')
  const invalid = await cli(['tools', '--unknown'])
  assert.equal(invalid.code, 2)
  assert.equal(invalid.stderr, '')
  const error = decode(invalid.stdout).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.equal(error.source, 'artium-axi')
  assert.ok(error.next)
  assert.equal((await cli(['falcon-axi', 'exit', '7'])).code, 7)
  const stderr = await cli(['falcon-axi', 'stderr', '3'])
  assert.deepEqual([stderr.code, stderr.stdout, stderr.stderr], [0, '', 'xxx'])
  const denied = await cli(['falcon-axi', '--region', 'synthetic.invalid'])
  assert.equal(denied.code, 2)
  assert.equal(decode(denied.stdout).error.code, 'FLAG_BLOCKED')
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'falcon-axi'")
  const disabled = await cli(['falcon-axi', 'detection', 'list'])
  assert.equal(disabled.code, 1)
  assert.equal(decode(disabled.stdout).error.code, 'TOOL_DISABLED')
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  pass(6, 'Structured errors and exit codes: usage, failure and upstream streams')
  const hook = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0]
  const context = await execute(hook.command, hook.args, options)
  assert.equal(context.stdout, toolsText)
  assert.equal(context.stderr, '')
  pass(7, 'Ambient context: embedded skills and executable opt-in hook')
  assert.equal(homeView.user, 'synthetic-user')
  assert.equal(homeView.roles.length, 1)
  assert.ok(homeView.bin && homeView.description)
  assert.equal(homeView.usage, undefined)
  pass(8, 'Content first: live identity, roles and tools without arguments')
  for (const suggestion of tools.next) {
    const args = suggestion.split(' ')
    assert.equal(args.shift(), 'artium-axi')
    await success(args)
  }
  pass(9, 'Contextual disclosure: suggested detail and first-call commands execute')
  for (const args of [[], ['tools'], ['tools', 'show', 'falcon-axi'], ['whoami'], ['login'], ['passwd'], ['logout'], ['doctor'], ['setup']]) {
    const help = decode(await success([...args, '--help']))
    assert.deepEqual(Object.keys(help), ['usage', 'purpose', 'flags', 'example'])
    assert.ok(help.usage.startsWith('artium-axi') && help.purpose && help.flags.length && help.example)
  }
  for (const tool of ['falcon-axi', 'vectra-axi']) {
    const help = decode(await success(['--help', tool]))
    assert.ok(help.usage && help.purpose && help.flags && help.example)
  }
  pass(10, 'Consistent help: all local command layouts and upstream detail')
  console.log('humanReview[7]:\n  - "1: Judge token efficiency on representative real upstream output."\n  - "2: Judge whether the minimal fields support real decisions."\n  - "3: Judge whether retained and full content is useful."\n  - "7: Verify actual host skill loading, hook trust and session usefulness."\n  - "8: Judge whether the home view contains the most relevant live content."\n  - "9: Judge relevance and validity of suggestions across real upstream commands."\n  - "10: Judge clarity and brevity of help for new users."')
  console.log('unverified: Actual Windows/macOS execution and unsupported host integrations require separate documentation and host verification; no paths are guessed.')
} finally {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (app) await app.close()
  else await runner?.shutdown()
  if (db?.open) db.close()
  rmSync(directory, { recursive: true, force: true })
  console.log(`axi-check-cleanup: temporary server, calls and fresh home removed; elapsedMs=${Math.round(performance.now() - started)}`)
}
