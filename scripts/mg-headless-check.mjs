import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = fileURLToPath(new URL('../', import.meta.url))
const name = `artium-test-mg-${randomUUID()}`
const image = process.env.ARTIUM_TEST_IMAGE ?? `${name}-image`
if (!/^artium-test-[a-z0-9-]+$/.test(image)) throw new Error('Headless probe requires a task-owned test image')
const started = performance.now()
try {
  if (!process.env.ARTIUM_TEST_IMAGE) {
    const build = spawnSync(process.execPath, ['scripts/build-fake-service-image.mjs'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, ARTIUM_TEST_IMAGE: image },
    })
    if (build.error || build.status !== 0) throw new Error('Headless test image build failed')
  }
  const identity = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' })
  if (identity.status !== 0) throw new Error('Headless test image unavailable')
  console.log(`mg-headless: image=${identity.stdout.trim()}`)
  const result = spawnSync('docker', ['run', '--name', name, '--pull', 'never', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--env', 'HOME=/tmp',
    '--mount', `type=bind,src=${root}/tools,dst=/work/tools,readonly`,
    '--mount', `type=bind,src=${root}/test/fake-tool,dst=/work/test/fake-tool,readonly`,
    '--workdir', '/work', image, 'node', '/work/test/fake-tool/mg-headless.mjs'],
  { stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `Headless probe exited ${result.status}`)
  console.log(`mg-headless: passed elapsedMs=${Math.round(performance.now() - started)}`)
} finally {
  const result = spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0 && !result.stderr.includes('No such container')) throw new Error('Headless container cleanup failed')
  if (!process.env.ARTIUM_TEST_IMAGE) {
    const cleanup = spawnSync('docker', ['image', 'rm', image], { encoding: 'utf8', timeout: 30_000 })
    if (cleanup.status !== 0 && !cleanup.stderr.includes('No such image')) throw new Error('Headless image cleanup failed')
  }
  console.log(`mg-headless: container ${name} removed; task-owned image cleaned by its owner`)
}
