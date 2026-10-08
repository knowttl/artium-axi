import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const image = `artium-test-runner-s09-10-${randomUUID()}`
const containers = []
let ownedImage = false
function command(executable, args, timeout = 300_000) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout })
  if (result.stdout) console.log(result.stdout.trim())
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
}
try {
  command('docker', ['info', '--format', '{{.ServerVersion}}'])
  ownedImage = true
  command(process.execPath, ['scripts/build-fake-service-image.mjs', '--runner', image])
  for (const mode of ['tmpfs', 'memory']) {
    const name = `artium-test-runner-${randomUUID()}`
    containers.push(name)
    command('docker', ['run', '--name', name, '--pull', 'never', '--init', '--network', 'none', '--read-only',
      '--memory', mode === 'memory' ? '256m' : '6g', '--memory-swap', mode === 'memory' ? '256m' : '6g', '--pids-limit', '192',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,nr_inodes=1024,mode=1777', image, 'node', 'test/runner/probe.mjs', mode])
  }
} catch (error) {
  console.error(`runner-container: unverified: ${error.message}`)
  process.exitCode = 1
} finally {
  for (const name of containers) {
    try { command('docker', ['rm', '--force', name], 30_000) }
    catch (error) { console.error(`Cleanup failed: ${error.message}`); process.exitCode = 1 }
  }
  if (ownedImage) {
    const result = spawnSync('docker', ['image', 'rm', image], { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !result.stderr.includes('No such image'))) {
      console.error(`Cleanup failed for ${image}`)
      process.exitCode = 1
    }
  }
}
