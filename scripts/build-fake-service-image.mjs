import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const builder = `artium-test-build-${randomUUID()}`
const production = process.argv.includes('--production')
const runner = process.argv.includes('--runner')
const large = production || runner
const image = runner ? 'artium-test-runner-s09-10' : production ? 'artium-axi:local' : 'artium-test-node22'
const directory = mkdtempSync(join(root, '.tmp-image-'))
const docker = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  if (result.stdout) console.log(result.stdout.trim())
}
let attempted = false
try {
  const existing = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' })
  if (existing.status === 0) throw new Error(`${image} already exists; refusing to replace it`)
  // The private BuildKit worker keeps cache on tmpfs. Removing it cannot prune another build.
  attempted = true
  docker(['run', '--detach', '--pull', 'never', '--privileged', '--name', builder,
    '--cpus', '2', '--memory', large ? '4g' : '1g', '--tmpfs', `/var/lib/buildkit:rw,exec,size=${large ? 3221225472 : 536870912}`,
    '--mount', `type=bind,src=${production || runner ? root : join(root, 'test/fake-service')},dst=/context,readonly`,
    'moby/buildkit:buildx-stable-1', `--oci-worker-snapshotter=${large ? 'overlayfs' : 'native'}`])
  docker(['exec', builder, 'buildctl', '--wait', '--timeout', '60', 'build',
    '--frontend', 'dockerfile.v0', '--local', 'context=/context', '--local', 'dockerfile=/context',
    ...(runner ? ['--opt', 'filename=test/runner/Dockerfile'] : []),
    '--output', `type=docker,name=${image},dest=/tmp/artium-test-image.tar`])
  const archive = join(directory, 'image.tar')
  docker(['cp', `${builder}:/tmp/artium-test-image.tar`, archive])
  docker(['load', '--input', archive])
  console.log(`image: ${image}`)
} catch (error) {
  console.error(`test-image: ${error.message}`)
  process.exitCode = 1
} finally {
  if (attempted) {
    const result = spawnSync('docker', ['rm', '--force', builder], { encoding: 'utf8', timeout: 30_000 })
    if (result.error || (result.status !== 0 && !result.stderr.includes('No such container'))) {
      console.error(`Cleanup failed for ${builder}`)
      process.exitCode = 1
    }
  }
  rmSync(directory, { recursive: true, force: true })
}
