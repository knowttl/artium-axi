import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestCertificates } from '../test/fake-service/certificates.mjs'

const directory = mkdtempSync(join(tmpdir(), 'artium-falcon-'))
let requests = 0
let canaryReceived = false
createTestCertificates(directory, ['localhost'])
const server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) }, (request, response) => {
  requests++
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    canaryReceived ||= body.includes('CANARY-falcon-secret')
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ errors: [{ code: 401, message: 'Synthetic rejection' }] }))
  })
})
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(443, '127.0.0.1', resolve)
  })
  const origin = 'https://localhost'
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('/opt/falcon-axi/bin/falcon-axi', ['detection', 'list', '--region', origin, ...args], {
      env: { PATH: process.env.PATH, HOME: directory, REQUESTS_CA_BUNDLE: join(directory, 'ca.crt'),
        FALCON_CLIENT_ID: 'CANARY-falcon-id', FALCON_CLIENT_SECRET: 'CANARY-falcon-secret' },
      timeout: 15_000,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
  const refused = await run([])
  assert.notEqual(refused.code, 0)
  assert.match(refused.output, /ORIGIN_NOT_ALLOWED/)
  assert.equal(requests, 0)
  const allowed = await run(['--allow-unknown-origin'])
  assert.notEqual(allowed.code, 0)
  assert.match(allowed.output, /AUTH_FAILED/)
  assert.equal(requests, 1)
  assert.equal(canaryReceived, true)
  console.log('Falcon unknown-origin refusal and explicit canary TLS delivery passed')
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
