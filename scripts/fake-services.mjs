import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestCertificates } from '../test/fake-service/certificates.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const image = process.env.ARTIUM_TEST_IMAGE ?? 'artium-test-node22'
const hosts = ['management.azure.com', 'api.loganalytics.io', 'graph.microsoft.com', 'login.microsoftonline.com',
  'synthetic.blob.core.windows.net', 'synthetic.vault.azure.net', 'synthetic.azurecr.io', 'appliance.test']
const name = `artium-test-${randomUUID()}`
const containers = []
const networks = []
const certs = mkdtempSync(join(root, '.tmp-fake-services-'))
const command = (bin, args) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(`${bin}: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}
const docker = (...args) => command('docker', args)
const start = (suffix, network, aliases = []) => {
  const container = `${name}-${suffix}`
  containers.push(container)
  docker('run', '--detach', '--pull', 'never', '--name', container, '--network', network,
    ...aliases.flatMap(host => ['--network-alias', host]),
    '--mount', `type=bind,src=${root},dst=/work,readonly`,
    '--mount', `type=bind,src=${certs},dst=/certs,readonly`,
    image, 'node', '/work/test/fake-service/server.mjs')
  return container
}
const ready = container => new Promise((resolve, reject) => {
  const logs = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const timeout = setTimeout(() => { logs.kill(); reject(new Error('Fake service readiness timed out')) }, 30_000)
  logs.on('error', error => { clearTimeout(timeout); reject(error) })
  logs.on('close', () => { clearTimeout(timeout); reject(new Error('Fake service exited before readiness')) })
  logs.stdout.on('data', chunk => {
    output += chunk.toString()
    if (output.includes('artium-test-ready')) { clearTimeout(timeout); logs.kill(); resolve() }
  })
})

try {
  if (!image.startsWith('artium-test-')) throw new Error('ARTIUM_TEST_IMAGE must name an existing artium-test- image')
  docker('image', 'inspect', image)
  const versionContainer = `${name}-version`
  containers.push(versionContainer)
  const version = docker('run', '--rm', '--pull', 'never', '--network', 'none', '--name', versionContainer, image, 'node', '--version')
  if (Number(version.slice(1).split('.')[0]) < 22) throw new Error('Harness image requires Node 22 or later')
  createTestCertificates(certs, hosts)
  for (const suffix of ['inside', 'outside']) {
    const network = `${name}-${suffix}`
    networks.push(network)
    docker('network', 'create', '--internal', network)
    if (!JSON.parse(docker('network', 'inspect', network))[0].Internal) throw new Error('Network is not internal')
  }
  const service = start('service', networks[0], hosts)
  const outside = start('outside', networks[1])
  await Promise.all([ready(service), ready(outside)])
  const outsideIp = Object.values(JSON.parse(docker('inspect', outside))[0].NetworkSettings.Networks)[0].IPAddress
  const client = `${name}-client`
  containers.push(client)
  console.log(docker('run', '--rm', '--pull', 'never', '--name', client, '--network', networks[0],
    '--mount', `type=bind,src=${root},dst=/work,readonly`, '--mount', `type=bind,src=${certs},dst=/certs,readonly`,
    '--env', 'NODE_EXTRA_CA_CERTS=/certs/ca.crt', '--env', 'AZ_AXI_ARM_TOKEN=CANARY-synthetic',
    '--env', `ARTIUM_TEST_HOSTS=${JSON.stringify(hosts)}`, '--env', `ARTIUM_TEST_OUTSIDE_IP=${outsideIp}`,
    image, 'node', '/work/test/fake-service/probe.mjs'))
} catch (error) {
  console.error(`fake-services: unverified: ${error.message}`)
  process.exitCode = 1
} finally {
  for (const container of containers.reverse()) {
    const result = spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !result.stderr.includes('No such container'))) {
      console.error(`Cleanup failed for ${container}`)
      process.exitCode = 1
    }
  }
  for (const network of networks.reverse()) {
    const result = spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !result.stderr.includes(`network ${network} not found`))) {
      console.error(`Cleanup failed for ${network}`)
      process.exitCode = 1
    }
  }
  rmSync(certs, { recursive: true, force: true })
}
