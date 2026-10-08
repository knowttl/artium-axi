import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'artium-cli-standalone-'))
copyFileSync('/work/dist/cli/artium-axi.mjs', join(directory, 'artium-axi.mjs'))
const execute = async (bin, args, env = {}) => {
  const child = spawn(bin, args, { cwd: directory, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'close')
  return { stdout, stderr, code }
}
const environment = { ARTIUM_AXI_URL: 'http://artium-server:8080', ARTIUM_AXI_DEV_TOKEN_FILE: join(directory, 'access-token'), ARTIUM_AXI_TEST_HTTP: '1' }
// The CLI uses HTTPS to the local test proxy. HTTP is never permitted to the container hostname.
try {
  assert.deepEqual(readdirSync(directory), ['artium-axi.mjs'])
  const { createServer } = await import('node:https')
  const { readFileSync } = await import('node:fs')
  const proxy = createServer({ key: readFileSync('/certs/server.key'), cert: readFileSync('/certs/server.crt') }, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const upstream = await fetch(`http://artium-server:8080${req.url}`, { method: req.method,
        headers: { authorization: req.headers.authorization, ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      res.writeHead(upstream.status, { 'content-type': 'application/json' })
      res.end(await upstream.text())
    } catch { res.writeHead(502); res.end() }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  environment.ARTIUM_AXI_URL = `https://localhost:${proxy.address().port}`
  environment.ARTIUM_AXI_CA_FILE = '/certs/ca.crt'
  try {
    const signIn = password => fetch('http://artium-server:8080/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'synthetic-admin', password }),
    })
    const restricted = await signIn('CANARY-bootstrap-password')
    assert.equal(restricted.status, 200)
    const first = await restricted.json()
    assert.equal(first.status, 'password-change-required')
    const changed = await fetch('http://artium-server:8080/v1/auth/password', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.passwordChangeToken}` },
      body: JSON.stringify({ newPassword: 'CANARY-changed-password' }),
    })
    assert.equal(changed.status, 204)
    const login = await signIn('CANARY-changed-password')
    assert.equal(login.status, 200)
    const session = await login.json()
    assert.equal(session.status, 'authenticated')
    writeFileSync(environment.ARTIUM_AXI_DEV_TOKEN_FILE, session.accessToken, { mode: 0o600 })
    const cli = args => execute(process.execPath, [join(directory, 'artium-axi.mjs'), ...args], environment)
    const listing = await cli(['tools'])
    assert.equal(listing.code, 0, listing.stdout + listing.stderr)
    assert.match(listing.stdout, /falcon-axi,unknown,"0.3.0"/)
    if (process.argv[2] === 'canary') {
      const result = await cli(['falcon-axi', 'env'])
      assert.equal(result.code, 1)
      assert.match(result.stdout, /SECRET_IN_OUTPUT/)
      assert.doesNotMatch(result.stdout, /CANARY-falcon|FALCON_CLIENT|stdout:|stderr:/)
      assert.equal(result.stderr, '')
      assert.equal(process.version, 'v22.12.0')
      console.log(JSON.stringify({ runtime: process.version, bundle: 'no sibling assets or node_modules', canary: 'fake env emits injected secret; CLI receives SECRET_IN_OUTPUT without either stream' }))
    } else {
      const clean = text => text.replace(/^(?:duration_ms|elapsed_ms|durationMs):.*\n/gm, '')
      for (const args of [['detection', 'list'], ['detection', 'list', '--limit', '1'],
        ['detection', 'list', '--filter', "hostname:'synthetic-empty'"], ['detection', 'list', '--unknown']]) {
        const local = await execute('/opt/falcon-axi/bin/falcon-axi', [...args, '--region', 'us-1'], {
          FALCON_CLIENT_ID: 'CANARY-falcon-id', FALCON_CLIENT_SECRET: 'CANARY-falcon-secret', REQUESTS_CA_BUNDLE: '/certs/ca.crt',
        })
        const remote = await cli(['falcon-axi', ...args])
        assert.deepEqual({ ...remote, stdout: clean(remote.stdout), stderr: clean(remote.stderr) },
          { ...local, stdout: clean(local.stdout), stderr: clean(local.stderr) })
        if (!args.includes('--unknown') && !args.includes('--filter')) assert.match(remote.stdout, /synthetic-detection/)
        if (args.includes('--filter')) assert.doesNotMatch(remote.stdout, /synthetic-detection/)
      }
      const redaction = await execute('/opt/falcon-axi/bin/falcon-axi', ['detection', 'list', '--filter', "hostname:'synthetic-redaction'", '--region', 'us-1'], {
        FALCON_CLIENT_ID: 'CANARY-falcon-id', FALCON_CLIENT_SECRET: 'CANARY-falcon-secret', REQUESTS_CA_BUNDLE: '/certs/ca.crt',
      })
      assert.equal(redaction.code, 0)
      console.log(JSON.stringify({ pinnedFalconRedaction: 'synthetic minted token echoed in display field',
        rawMintedTokenVisible: redaction.stdout.includes('CANARY-falcon-token') || redaction.stderr.includes('CANARY-falcon-token') }))
      const { createVectraAdapter } = await import('/opt/artium/dist/src/server/adapters/vectra.js')
      const adapter = createVectraAdapter({ getCredential: async () => ({
        kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test', auth: 'token', token: 'CANARY-vectra-token',
        caBundle: readFileSync('/certs/ca.crt', 'utf8'), writes: { allowWrites: true, operations: ['qux.detection.tag.set'] },
      }) }, join(directory, 'writes.log'))
      // The profile's CA is used by the actual binary; the harness reads evidence through HTTPS with its test CA.
      const requests = async () => {
        const { request } = await import('node:https')
        return new Promise((resolve, reject) => {
          const req = request('https://appliance.test/__evidence', { ca: readFileSync('/certs/ca.crt') }, res => {
            let body = ''
            res.on('data', chunk => { body += chunk })
            res.on('end', () => resolve(JSON.parse(body)))
          })
          req.on('error', reject)
          req.end()
        })
      }
      const tagArgs = ['detection', 'tag', 'set', '--id', '42', '--tags', 'synthetic']
      const prepared = await adapter.prepare(tagArgs, { id: 'synthetic-vectra', tool: 'vectra-axi' })
      for (const file of prepared.files) writeFileSync(join(directory, file.name), file.content, { mode: 0o600 })
      for (const args of [['detection', 'list'], tagArgs, [...tagArgs, '--dry-run'], [...tagArgs, '--execute']]) {
        const local = await execute(prepared.executable, args, prepared.environment)
        const remote = await cli(['vectra-axi', ...args])
        assert.deepEqual(remote, local)
      }
      assert.equal((await requests()).mutations, 0)
      const write = await cli(['vectra-axi', ...tagArgs, '--execute', '--confirm', 'detection 42'])
      assert.equal(write.code, 0, write.stdout + write.stderr)
      assert.equal((await requests()).mutations, 1)
      const log = '/test-data/tool-logs/vectra-axi/writes.log'
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind), ['intent', 'outcome'])
      assert.equal(statSync(log).mode & 0o777, 0o600)
      console.log(JSON.stringify({ pinnedVectra: '0.1.3', profile: 'local and Artium parity', dryRun: 'zero mutations',
        execute: 'one confirmed canary write', nativeLog: 'durable mode 0600 after runner cleanup', live: 'unverified' }))
      console.log(JSON.stringify({ runtime: process.version, bundle: 'no sibling assets or node_modules', pinnedFalcon: '0.3.0', parity: 'read, pagination, empty and usage-error stdout/stderr/exit match', live: 'unverified' }))
    }
  } finally { await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) }
} finally { rmSync(directory, { recursive: true, force: true }) }
