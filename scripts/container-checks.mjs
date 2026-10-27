import { spawn, spawnSync } from 'node:child_process'
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
const command = (executable, args, env = process.env) => new Promise((resolve, reject) => {
  const started = performance.now()
  const child = spawn(executable, args, { stdio: 'inherit', env })
  child.once('error', reject)
  child.once('close', status => {
    console.log(`container-command: ${JSON.stringify({ executable, args, status, elapsedMs: Math.round(performance.now() - started) })}`)
    if (status === 0) resolve()
    else reject(new Error(`${executable} failed (${status})`))
  })
})
let attempted = false
let inputs
let output
let cleanupPassed = true
try {
  await command(process.execPath, ['scripts/build.mjs'])
  inputs = buildInputs()
  output = digest(['dist/'])
  console.log(`container-inputs: ${JSON.stringify({ ...inputs, output, platform: process.platform, arch: process.arch, builder })}`)
  await command('docker', ['info', '--format', '{{.ServerVersion}}'])
  attempted = true
  await command('docker', ['run', '--detach', '--pull', 'never', '--privileged', '--name', builder,
    '--label', `artium-test.root=${root}`, '--label', `artium-test.token=${token}`,
    '--cpus', '6', '--memory', '4g', '--tmpfs', '/var/lib/buildkit:rw,exec,size=3221225472',
    '--mount', `type=bind,src=${root},dst=/context,readonly`,
    'moby/buildkit:buildx-stable-1', '--oci-worker-snapshotter=overlayfs'])
  const env = { ...process.env, ARTIUM_TEST_BUILDER: builder, ARTIUM_TEST_BUILD_TOKEN: token }
  const checkServices = async flag => {
    const probe = flag ? ['--falcon'] : []
    const image = `${builder}-${flag ? 'falcon' : 'services'}`
    images.push(image)
    await command(process.execPath, ['scripts/build-fake-service-image.mjs', ...(flag ? [flag, image] : [])],
      { ...env, ARTIUM_TEST_IMAGE: image })
    if (!flag) await command(process.execPath, ['scripts/mg-headless-check.mjs'], { ...env, ARTIUM_TEST_IMAGE: image })
    await command(process.execPath, ['scripts/fake-services.mjs', ...probe], { ...env, ARTIUM_TEST_IMAGE: image })
    if (flag === '--production') {
      const artifacts = `${builder}-artifacts`
      recoveryContainers.push(artifacts)
      await command('docker', ['run', '--name', artifacts, '--pull', 'never', '--init', '--network', 'none', '--read-only',
        '--memory', '6g', '--memory-swap', '6g', '--pids-limit', '192',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
        '--tmpfs', '/tmp/artium-artifacts:rw,noexec,nosuid,nodev,size=1073741824,mode=0700,uid=10001,gid=10001',
        '--mount', `type=bind,src=${root},dst=/work,readonly`, image, 'node', '/work/test/runner/artifact-probe.mjs'])
      const packaged = `${builder}-mg-package`
      recoveryContainers.push(packaged)
      await command('docker', ['run', '--name', packaged, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/mg-axi', image, '--version'])
      const ldapPackage = `${builder}-ldap-package`
      recoveryContainers.push(ldapPackage)
      await command('docker', ['run', '--name', ldapPackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/ldap-axi', image, 'user', 'list', '--help'])
      const adoPackage = `${builder}-ado-package`
      recoveryContainers.push(adoPackage)
      await command('docker', ['run', '--name', adoPackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/ado-axi', image, '--version'])
      const awxPackage = `${builder}-awx-package`
      recoveryContainers.push(awxPackage)
      await command('docker', ['run', '--name', awxPackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/awx-axi', image, '--version'])
      const tenablePackage = `${builder}-tenable-package`
      const checkpointPackage = `${builder}-checkpoint-package`
      recoveryContainers.push(checkpointPackage)
      await command('docker', ['run', '--name', checkpointPackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/checkpoint-axi', image, '--version'])
      const hybridPackage = `${builder}-hybrid-package`
      recoveryContainers.push(hybridPackage)
      await command('docker', ['run', '--name', hybridPackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/hybrid-axi', image, '--version'])
      recoveryContainers.push(tenablePackage)
      await command('docker', ['run', '--name', tenablePackage, '--pull', 'never', '--network', 'none', '--read-only',
        '--entrypoint', '/opt/tools/node_modules/.bin/tenable-axi', image, '--version'])
      const adoToken = `${builder}-ado-token`
      recoveryContainers.push(adoToken)
      await command('docker', ['run', '--name', adoToken, '--pull', 'never', '--network', 'none', '--read-only',
        '-e', 'ARTIUM_SECRET_0=CANARY-ado-token', '-e', 'ARTIUM_ADO_EXPIRES_ON=2030-01-01 00:00:00',
        '--entrypoint', '/opt/artium/libexec/ado-axi/az', image,
        'account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--output', 'json'])
      const backupVolume = `${builder}-backup`
      const restoreVolume = `${builder}-restore`
      for (const volume of [backupVolume, restoreVolume]) {
        recoveryVolumes.push(volume)
        await command('docker', ['volume', 'create', volume])
      }
      for (const mode of ['backup', 'restore']) {
        const container = `${builder}-${mode}`
        recoveryContainers.push(container)
        await command('docker', ['run', '--name', container, '--pull', 'never', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
          '--mount', `type=bind,src=${root},dst=/work,readonly`,
          '--mount', `type=volume,src=${mode === 'backup' ? backupVolume : restoreVolume},dst=/data`,
          ...(mode === 'restore' ? ['--mount', `type=volume,src=${backupVolume},dst=/backups,readonly`] : []),
          image, 'node', '/work/test/fake-service/backup-probe.mjs', mode])
      }
    }
  }
  // Settle every phase before cleanup, including when another phase fails.
  const phases = await Promise.allSettled([
    (async () => {
      await command(process.execPath, ['scripts/runner-container-check.mjs'], env)
      if (process.argv.includes('--measure-cache')) await command(process.execPath, ['scripts/runner-container-check.mjs'], env)
    })(),
    command(process.execPath, ['scripts/walking-skeleton.mjs'], env),
    ...[null, '--production'].map(checkServices),
  ])
  const failure = phases.find(phase => phase.status === 'rejected')
  if (failure) throw failure.reason
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
