import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestCertificates } from '../test/fake-service/certificates.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const name = `artium-test-s20-21-${randomUUID()}`
const image = `${name}-server`
const cliImage = `${name}-node22-12`
const directory = mkdtempSync(join(root, '.tmp-walking-'))
const containers = []
const images = []
const volumes = []
let network = false
const masterKey = randomBytes(32).toString('base64')
const token = randomBytes(32).toString('base64url')
const command = (bin, args, timeout = 60_000) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout })
  if (result.error || result.status !== 0) throw new Error(`${bin}: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  return result.stdout.trim()
}
const docker = (...args) => command('docker', args)
const mounts = ['--mount', `type=bind,src=${root},dst=/work,readonly`, '--mount', `type=bind,src=${directory},dst=/certs,readonly`]
const ready = container => new Promise((resolve, reject) => {
  const logs = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const timeout = setTimeout(() => { logs.kill(); reject(new Error('Container readiness timed out')) }, 30_000)
  logs.once('error', error => { clearTimeout(timeout); reject(error) })
  logs.once('close', () => { clearTimeout(timeout); reject(new Error('Container exited before readiness')) })
  logs.stdout.on('data', chunk => {
    output += chunk
    if (output.includes('artium-test-ready')) { clearTimeout(timeout); logs.kill(); resolve() }
  })
})
const run = (suffix, args) => {
  const container = `${name}-${suffix}`
  containers.push(container)
  return docker('run', '--pull', 'never', '--name', container, ...args)
}
try {
  for (const [flag, tag] of [['--production', image], ['--cli', cliImage]]) {
    images.push(tag)
    console.log(command(process.execPath, ['scripts/build-fake-service-image.mjs', flag, tag], 0))
  }
  console.log(`server image: ${docker('image', 'inspect', image, '--format', '{{.Id}}')}`)
  const hosts = ['api.crowdstrike.com', 'localhost']
  createTestCertificates(directory, hosts)
  chmodSync(directory, 0o755)
  chmodSync(join(directory, 'server.key'), 0o644)
  writeFileSync(join(directory, 'token'), token, { mode: 0o600 })
  copyFileSync(join(root, 'test/fake-tool/environment.py'), join(directory, 'fake-axi'))
  chmodSync(join(directory, 'fake-axi'), 0o755)
  docker('network', 'create', '--internal', name)
  network = true
  if (!JSON.parse(docker('network', 'inspect', name))[0].Internal) throw new Error('Fake-only network must be internal')
  const service = `${name}-service`
  run('service', ['--detach', '--network', name, '--network-alias', 'api.crowdstrike.com', ...mounts,
    cliImage, 'node', '/work/test/fake-service/server.mjs'])
  await ready(service)
  for (const mode of ['pinned', 'canary']) {
    if (mode === 'canary') {
      const output = run('local-env', ['--rm', '--network', 'none', ...mounts,
        '--env', 'FALCON_CLIENT_ID=CANARY-falcon-id', '--env', 'FALCON_CLIENT_SECRET=CANARY-falcon-secret',
        image, 'python3', '/work/test/fake-tool/environment.py', 'env'])
      assert.equal(JSON.parse(output).FALCON_CLIENT_SECRET, 'CANARY-falcon-secret')
    }
    const volume = `${name}-${mode}-data`
    volumes.push(volume)
    docker('volume', 'create', volume)
    const data = ['--mount', `type=volume,src=${volume},dst=/data`]
    run(`${mode}-setup`, ['--rm', '--user', '0', '--network', 'none', ...mounts, ...data,
      '--env', `ARTIUM_AXI_MASTER_KEY=${masterKey}`, '--env', `ARTIUM_TEST_TOKEN=${token}`,
      image, 'node', '/work/test/walking-skeleton/setup.mjs'])
    run(`${mode}-ownership`, ['--rm', '--user', '0', '--network', 'none', ...data, image, 'chown', '-R', '10001:10001', '/data'])
    const trust = mode === 'pinned' ? ['--mount', `type=bind,src=${join(directory, 'ca.crt')},dst=/opt/falcon-axi/lib/python3.11/site-packages/certifi/cacert.pem,readonly`] :
      ['--mount', `type=bind,src=${join(directory, 'fake-axi')},dst=/opt/falcon-axi/bin/falcon-axi,readonly`]
    run(`${mode}-server`, ['--detach', '--init', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
      '--network', name, '--network-alias', 'artium-server', ...mounts, ...data, ...trust,
      '--env', 'ARTIUM_AXI_DEV=1', '--env', 'ARTIUM_AXI_DEV_TOKEN_FILE=/data/token', '--env', `ARTIUM_AXI_MASTER_KEY=${masterKey}`,
      image, 'node', '--import', '/work/test/walking-skeleton/ready.mjs', 'dist/src/server/main.js'])
    await ready(`${name}-${mode}-server`)
    console.log(run(`${mode}-client`, ['--rm', '--user', '0', '--network', name, ...mounts,
      '--mount', `type=bind,src=${join(directory, 'token')},dst=/test-token,readonly`,
      mode === 'pinned' ? image : cliImage, 'node', '/work/test/walking-skeleton/probe.mjs', mode]))
    docker('stop', `${name}-${mode}-server`)
  }
} catch (error) {
  console.error(`walking-skeleton: unverified: ${error.message}`)
  process.exitCode = 1
} finally {
  const cleanup = args => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !/No such|not found/.test(result.stderr))) {
      console.error(`Cleanup failed: ${args.join(' ')}`)
      process.exitCode = 1
    }
  }
  for (const container of containers.reverse()) cleanup(['rm', '--force', container])
  for (const volume of volumes) cleanup(['volume', 'rm', volume])
  if (network) cleanup(['network', 'rm', name])
  for (const tag of images) cleanup(['image', 'rm', tag])
  rmSync(directory, { recursive: true, force: true })
}
