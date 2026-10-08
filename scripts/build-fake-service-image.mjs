import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = fileURLToPath(new URL('../', import.meta.url))
const cachedBuilder = process.env.ARTIUM_TEST_BUILDER
const builder = cachedBuilder ?? `artium-test-build-${randomUUID()}`
const production = process.argv.includes('--production')
const runner = process.argv.includes('--runner')
const cli = process.argv.includes('--cli')
const large = production || runner
const productionTag = process.argv[process.argv.indexOf('--production') + 1]
const image = cli ? process.argv[process.argv.indexOf('--cli') + 1] : runner ? process.argv[process.argv.indexOf('--runner') + 1] : production ? productionTag ?? 'artium-axi:local' : process.env.ARTIUM_TEST_IMAGE ?? 'artium-test-node22'
if (runner && (!image || image.startsWith('--'))) throw new Error('--runner requires an image tag')
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
  if (cachedBuilder) {
    if (!/^artium-test-build-[0-9a-f-]{36}$/.test(builder) || !process.env.ARTIUM_TEST_BUILD_TOKEN) throw new Error('Invalid task builder')
    const ownership = spawnSync('docker', ['inspect', builder, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' })
    if (ownership.error || ownership.status !== 0) throw new Error('Task builder unavailable')
    const labels = JSON.parse(ownership.stdout)
    if (labels['artium-test.root'] !== root || labels['artium-test.token'] !== process.env.ARTIUM_TEST_BUILD_TOKEN) throw new Error('Task builder ownership mismatch')
  } else {
    // The private BuildKit worker keeps cache on tmpfs. Removing it cannot prune another build.
    attempted = true
    docker(['run', '--detach', '--pull', 'never', '--privileged', '--name', builder,
    '--cpus', '2', '--memory', large ? '4g' : '1g', '--tmpfs', `/var/lib/buildkit:rw,exec,size=${large ? 3221225472 : 536870912}`,
    '--mount', `type=bind,src=${cli ? join(root, 'test/walking-skeleton') : production || runner ? root : join(root, 'test/fake-service')},dst=/context,readonly`,
      'moby/buildkit:buildx-stable-1', `--oci-worker-snapshotter=${large ? 'overlayfs' : 'native'}`])
  }
  const context = cachedBuilder ? cli ? '/context/test/walking-skeleton' : production || runner ? '/context' : '/context/test/fake-service' : '/context'
  const started = performance.now()
  docker(['exec', builder, 'buildctl', '--wait', '--timeout', '60', 'build',
    '--frontend', 'dockerfile.v0', '--local', `context=${context}`, '--local', `dockerfile=${context}`,
    ...(runner ? ['--opt', 'filename=test/runner/Dockerfile'] : []),
    '--output', `type=docker,name=${image},dest=/tmp/artium-test-image.tar`])
  console.log(`image-build: ${JSON.stringify({ image, builder, elapsedMs: Math.round(performance.now() - started) })}`)
  const archive = join(directory, 'image.tar')
  docker(['cp', `${builder}:/tmp/artium-test-image.tar`, archive])
  docker(['load', '--input', archive])
  docker(['image', 'inspect', image, '--format', '{{.Id}}'])
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
