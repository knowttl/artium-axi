import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
const environment = { ARTIUM_AXI_URL: 'http://artium-server:8080', ARTIUM_AXI_DEV_TOKEN_FILE: '/test-token', ARTIUM_AXI_TEST_HTTP: '1' }
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
      console.log(JSON.stringify({ runtime: process.version, bundle: 'no sibling assets or node_modules', pinnedFalcon: '0.3.0', parity: 'read, pagination, empty and usage-error stdout/stderr/exit match', live: 'unverified' }))
    }
  } finally { await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) }
} finally { rmSync(directory, { recursive: true, force: true }) }
