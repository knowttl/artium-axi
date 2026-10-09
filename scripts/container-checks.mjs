import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { buildInputs, digest } from './build-inputs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const builder = `artium-test-build-${randomUUID()}`
const token = randomUUID()
const images = []
const recoveryContainers = []
const recoveryVolumes = []
const started = performance.now()
const command = (executable, args, env = process.env) => {
  const started = performance.now()
  const result = spawnSync(executable, args, { stdio: 'inherit', env })
  console.log(`container-command: ${JSON.stringify({ executable, args, status: result.status, elapsedMs: Math.round(performance.now() - started) })}`)
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${executable} failed (${result.status})`)
}
let attempted = false
let inputs
let output
let cleanupPassed = true
try {
  command(process.execPath, ['scripts/build.mjs'])
  inputs = buildInputs()
  output = digest(['dist/'])
  console.log(`container-inputs: ${JSON.stringify({ ...inputs, output, platform: process.platform, arch: process.arch, builder })}`)
  command('docker', ['info', '--format', '{{.ServerVersion}}'])
  attempted = true
  command('docker', ['run', '--detach', '--pull', 'never', '--privileged', '--name', builder,
    '--label', `artium-test.root=${root}`, '--label', `artium-test.token=${token}`,
    '--cpus', '2', '--memory', '4g', '--tmpfs', '/var/lib/buildkit:rw,exec,size=3221225472',
    '--mount', `type=bind,src=${root},dst=/context,readonly`,
    'moby/buildkit:buildx-stable-1', '--oci-worker-snapshotter=overlayfs'])
  const env = { ...process.env, ARTIUM_TEST_BUILDER: builder, ARTIUM_TEST_BUILD_TOKEN: token }
  command(process.execPath, ['scripts/runner-container-check.mjs'], env)
  if (process.argv.includes('--measure-cache')) command(process.execPath, ['scripts/runner-container-check.mjs'], env)
  command(process.execPath, ['scripts/walking-skeleton.mjs'], env)
  for (const [flag, probe] of [[null, []], ['--production', ['--falcon']]]) {
    const image = `${builder}-${flag ? 'falcon' : 'services'}`
    images.push(image)
    command(process.execPath, ['scripts/build-fake-service-image.mjs', ...(flag ? [flag, image] : [])],
      { ...env, ARTIUM_TEST_IMAGE: image })
    command(process.execPath, ['scripts/fake-services.mjs', ...probe], { ...env, ARTIUM_TEST_IMAGE: image })
    if (flag === '--production') {
      const backupVolume = `${builder}-backup`
      const restoreVolume = `${builder}-restore`
      for (const volume of [backupVolume, restoreVolume]) {
        recoveryVolumes.push(volume)
        command('docker', ['volume', 'create', volume])
      }
      for (const mode of ['backup', 'restore']) {
        const container = `${builder}-${mode}`
        recoveryContainers.push(container)
        command('docker', ['run', '--name', container, '--pull', 'never', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
          '--mount', `type=bind,src=${root},dst=/work,readonly`,
          '--mount', `type=volume,src=${mode === 'backup' ? backupVolume : restoreVolume},dst=/data`,
          ...(mode === 'restore' ? ['--mount', `type=volume,src=${backupVolume},dst=/backups,readonly`] : []),
          image, 'node', '/work/test/fake-service/backup-probe.mjs', mode])
      }
    }
  }
  if (JSON.stringify(buildInputs()) !== JSON.stringify(inputs) || digest(['dist/']) !== output) throw new Error('Container inputs changed during checks')
} catch (error) {
  console.error(`container-checks: unverified: ${error.message}`)
  process.exitCode = 1
} finally {
  for (const args of [...recoveryContainers.map(name => ['rm', '--force', name]), ...recoveryVolumes.map(name => ['volume', 'rm', name]),
    ...images.map(image => ['image', 'rm', image]), ...(attempted ? [['rm', '--force', builder]] : [])]) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !/No such image|No such container|no such volume/.test(result.stderr))) {
      console.error(`container-checks: cleanup failed: ${args.join(' ')}`)
      cleanupPassed = false
      process.exitCode = 1
    }
  }
}
console.log(`container-evidence: ${JSON.stringify({ ...inputs, output, passed: !process.exitCode, elapsedMs: Math.round(performance.now() - started), cacheRemoved: cleanupPassed })}`)
