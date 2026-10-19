import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'artium-cli-standalone-'))
const install = join(directory, 'bin')
mkdirSync(install)
const execute = async (bin, args, env = {}, input) => {
  const child = spawn(bin, args, { cwd: directory, env: { PATH: process.env.PATH, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin?.end(input)
  const [code] = await once(child, 'close')
  return { stdout, stderr, code }
}
const environment = { PATH: `${install}:${process.env.PATH}`, HOME: directory, ARTIUM_AXI_URL: 'http://artium-server:8080',
  XDG_CONFIG_HOME: join(directory, 'config') }
// Parity permits the wrapper prefix and removal of managed flags from upstream help.
const upstreamSuggestions = (text, removeRegion = false) => {
  if (/^(?:artium-axi )?(?:falcon|vectra)-axi(?:\s|$)/.test(text)) {
    const unwrapped = text.replace(/^([ \t]*)artium-axi ((?:falcon|vectra)-axi)/gm, '$1$2')
    return removeRegion ? unwrapped.replace(/^  --help, --region <name\|url>, --allow-unknown-origin, --member-cid <cid>, --no-member-cid$/gm, '  --help') : unwrapped
  }
  let help = false
  return text.split('\n').map(line => {
    if (/^help(?:\[\d+\])?:/.test(line)) help = true
    else if (line && !line.startsWith(' ')) help = false
    if (!help) return line
    const unwrapped = line.replaceAll('artium-axi falcon-axi', 'falcon-axi').replaceAll('artium-axi vectra-axi', 'vectra-axi')
    return removeRegion ? unwrapped.replace(/ --region us-1(?=`)/g, '') : unwrapped
  }).join('\n')
}
// The CLI uses HTTPS to the local test proxy. HTTP is never permitted to the container hostname.
try {
  const { createServer } = await import('node:https')
  const { readFileSync } = await import('node:fs')
  const proxy = createServer({ key: readFileSync('/certs/server.key'), cert: readFileSync('/certs/server.crt') }, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const upstream = await fetch(`http://artium-server:8080${req.url}`, { method: req.method,
        headers: { authorization: req.headers.authorization, ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { res.writeHead(502); res.end() }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  environment.ARTIUM_AXI_URL = `https://localhost:${proxy.address().port}`
  environment.ARTIUM_AXI_CA_FILE = '/certs/ca.crt'
  try {
    const download = path => new Promise((resolve, reject) => {
      const request = get(`${environment.ARTIUM_AXI_URL}/cli/${path}`, { ca: readFileSync('/certs/ca.crt') }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }))
      })
      request.on('error', reject)
    })
    const bundle = await download('artium-axi.mjs')
    const checksum = await download('artium-axi.mjs.sha256')
    assert.equal(bundle.status, 200)
    assert.equal(checksum.status, 200)
    const digest = createHash('sha256').update(bundle.bytes).digest('hex')
    assert.equal(checksum.bytes.toString(), `${digest}  artium-axi.mjs\n`)
    assert.equal(bundle.headers['x-artium-cli-sha256'], digest)
    assert.ok(bundle.headers['x-artium-cli-version'])
    assert.match(bundle.headers['content-type'], /^text\/javascript/)
    writeFileSync(join(install, 'artium-axi'), bundle.bytes)
    chmodSync(join(install, 'artium-axi'), 0o755)
    assert.deepEqual(readdirSync(install), ['artium-axi'])
    const cli = (args, input) => execute('artium-axi', args, environment, input)
    const loginArgs = ['login', '--username', 'synthetic-admin', '--password-stdin']
    const restricted = await cli(loginArgs, 'CANARY-bootstrap-password\n')
    assert.equal(restricted.code, 1, restricted.stdout + restricted.stderr)
    assert.match(restricted.stdout, /PASSWORD_CHANGE_REQUIRED/)
    assert.doesNotMatch(restricted.stdout + restricted.stderr, /CANARY-|passwordChangeToken/)
    assert.match((await cli(['tools'])).stdout, /PASSWORD_CHANGE_REQUIRED/)
    const changed = await cli(['passwd', '--password-stdin'], 'CANARY-changed-password\n')
    assert.equal(changed.code, 0, changed.stdout + changed.stderr)
    const login = await cli(loginArgs, 'CANARY-changed-password\n')
    assert.equal(login.code, 0, login.stdout + login.stderr)
    assert.doesNotMatch(login.stdout + login.stderr, /CANARY-|accessToken|refreshToken/)
    for (const host of ['claude', 'codex', 'opencode', 'pi']) {
      const setup = await cli(['setup', '--host', host])
      assert.equal(setup.code, 0, setup.stdout + setup.stderr)
      assert.match(setup.stdout, /artium-axi,installed/)
      assert.match(setup.stdout, /falcon-axi,installed/)
    }
    const identity = await cli(['whoami'])
    assert.equal(identity.code, 0, identity.stdout + identity.stderr)
    assert.match(identity.stdout, /synthetic-admin/)
    const listing = await cli(['tools'])
    assert.equal(listing.code, 0, listing.stdout + listing.stderr)
    assert.match(listing.stdout, /falcon-axi,unknown,"0.5.0"/)
    const home = await cli([])
    assert.equal(home.code, 0, home.stdout + home.stderr)
    assert.match(home.stdout, /user: "synthetic-admin"/)
    assert.match(home.stdout, /roles\[1\]/)
    assert.match(home.stdout, /artium-axi tools show falcon-axi/)
    const detail = await cli(['tools', 'show', 'falcon-axi'])
    assert.equal(detail.code, 0, detail.stdout + detail.stderr)
    assert.match(detail.stdout, /example: artium-axi falcon-axi detection list/)
    if (process.argv[2] === 'distribution') {
      const first = await cli(['falcon-axi', 'detection', 'list'])
      assert.equal(first.code, 0, first.stdout + first.stderr)
      assert.match(first.stdout, /synthetic-detection/)
      assert.equal(process.version, 'v24.21.0')
      assert.deepEqual(readdirSync(install), ['artium-axi'])
      console.log(JSON.stringify({ distribution: 'clean Linux Node-only image, HTTPS download, verified SHA-256, executable launcher, all supported setup hosts, password change and first pinned fake call', sha256: digest, runtime: process.version }))
    } else if (process.argv[2] === 'canary') {
      const result = await cli(['falcon-axi', 'env'])
      assert.equal(result.code, 1)
      assert.match(result.stdout, /SECRET_IN_OUTPUT/)
      assert.doesNotMatch(result.stdout, /CANARY-falcon|FALCON_(?:AXI_)?CLIENT|stdout:|stderr:/)
      assert.equal(result.stderr, '')
      assert.equal(process.version, 'v24.21.0')
      console.log(JSON.stringify({ runtime: process.version, bundle: 'no sibling assets or node_modules', canary: 'fake env emits injected secret; CLI receives SECRET_IN_OUTPUT without either stream' }))
    } else {
      const clean = text => text.replace(/^(?:duration_ms|elapsed_ms|durationMs):.*\n/gm, '')
      for (const args of [[], ['--help'], ['detection', 'list', '--help'], ['detection', 'list'], ['detection', 'list', '--limit', '1'],
        ['detection', 'list', '--filter', "hostname:'synthetic-empty'"], ['detection', 'list', '--unknown']]) {
        const local = await execute('/opt/falcon-axi/bin/falcon-axi', [...args, '--region', 'us-1'], {
          FALCON_AXI_CLIENT_ID: 'CANARY-falcon-id', FALCON_AXI_CLIENT_SECRET: 'CANARY-falcon-secret', REQUESTS_CA_BUNDLE: '/certs/ca.crt',
        })
        const remote = await cli(['falcon-axi', ...args])
        assert.deepEqual({ ...remote, stdout: clean(upstreamSuggestions(remote.stdout)), stderr: clean(upstreamSuggestions(remote.stderr)) },
          { ...local, stdout: clean(upstreamSuggestions(local.stdout, true)), stderr: clean(upstreamSuggestions(local.stderr, true)) })
        if (!args.includes('--unknown') && !args.includes('--filter') && !args.includes('--help')) assert.match(remote.stdout, /synthetic-detection/)
        if (args.includes('--filter')) assert.doesNotMatch(remote.stdout, /synthetic-detection/)
      }
      const redaction = await execute('/opt/falcon-axi/bin/falcon-axi', ['detection', 'list', '--filter', "hostname:'synthetic-redaction'", '--region', 'us-1'], {
        FALCON_AXI_CLIENT_ID: 'CANARY-falcon-id', FALCON_AXI_CLIENT_SECRET: 'CANARY-falcon-secret', REQUESTS_CA_BUNDLE: '/certs/ca.crt',
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
      for (const file of prepared.files) {
        mkdirSync(dirname(join(directory, file.name)), { recursive: true, mode: 0o700 })
        writeFileSync(join(directory, file.name), file.content, { mode: 0o600 })
      }
      const vectraDetail = await cli(['tools', 'show', 'vectra-axi'])
      assert.equal(vectraDetail.code, 0, vectraDetail.stdout + vectraDetail.stderr)
      assert.match(vectraDetail.stdout, /example: artium-axi vectra-axi detection list/)
      for (const args of [[], ['--help'], ['detection', 'list', '--help'], ['detection', 'list'], tagArgs, [...tagArgs, '--dry-run'], [...tagArgs, '--execute']]) {
        const local = await execute(prepared.executable, args, { ...prepared.environment, XDG_CONFIG_HOME: directory })
        const remote = await cli(['vectra-axi', ...args])
        if (args.length === 0) {
          // Home reports the generated profile location, which belongs to each call's temp directory.
          const privateConfig = /^  config: \/tmp\/artium-calls\/artium-call-[^/\n]+\/config\/vectra-axi\/config\.json$/m
          assert.match(remote.stdout, privateConfig)
          assert.ok(local.stdout.includes(`  config: ${join(directory, 'vectra-axi/config.json')}\n`))
          remote.stdout = remote.stdout.replace(privateConfig, '  config: <private call>/vectra-axi/config.json')
          local.stdout = local.stdout.replace(`  config: ${join(directory, 'vectra-axi/config.json')}`, '  config: <private call>/vectra-axi/config.json')
        }
        assert.deepEqual({ ...remote, stdout: upstreamSuggestions(remote.stdout), stderr: upstreamSuggestions(remote.stderr) }, local)
      }
      assert.equal((await requests()).mutations, 0)
      const write = await cli(['vectra-axi', ...tagArgs, '--execute', '--confirm', 'detection 42'])
      assert.equal(write.code, 0, write.stdout + write.stderr)
      assert.equal((await requests()).mutations, 1)
      const logs = '/test-data/tool-logs/vectra-axi/writes.log.runs'
      const journals = readdirSync(logs).map(name => join(logs, name, 'writes.log')).filter(existsSync)
      assert.deepEqual(journals.flatMap(log => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind)), ['intent', 'outcome'])
      for (const log of journals) {
        assert.equal(statSync(log).mode & 0o777, 0o600)
        assert.equal(statSync(dirname(log)).mode & 0o777, 0o700)
      }
      assert.equal(statSync(logs).mode & 0o777, 0o700)
      console.log(JSON.stringify({ pinnedVectra: '0.1.7', profile: 'local and Artium parity', dryRun: 'zero mutations',
        execute: 'one confirmed canary write', nativeLog: 'durable mode 0600 after runner cleanup', live: 'unverified' }))
      console.log(JSON.stringify({ runtime: process.version, bundle: 'no sibling assets or node_modules', pinnedFalcon: '0.5.0', parity: 'read, pagination, empty and usage-error stdout/stderr/exit match', live: 'unverified' }))
    }
  } finally { await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) }
} finally { rmSync(directory, { recursive: true, force: true }) }
