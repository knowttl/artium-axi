import assert from 'node:assert/strict'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statfsSync, unlinkSync, writeSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Runner } from '../../dist/src/server/runner/runner.js'

const runner = await Runner.create()
const call = (args, limits = {}) => runner.run('synthetic-user', process.execPath, args, {}, [], limits)
try {
  assert.equal(process.getuid(), 10001)
  assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '192')
  assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), process.argv[2] === 'memory' ? '268435456' : '6442450944')
  const fs = statfsSync('/tmp')
  assert.equal(fs.blocks * fs.bsize, 256 * 1024 * 1024)
  if (process.argv[2] === 'memory') {
    const before = readFileSync('/sys/fs/cgroup/memory.events', 'utf8')
    await assert.rejects(call(['test/fake-tool/fake-axi.mjs', 'memory', '512'].map((arg, index) => index === 0 ? join(process.cwd(), arg) : arg), { timeoutMs: 15_000 }), { code: 'PROCESS_SIGNAL' })
    const after = readFileSync('/sys/fs/cgroup/memory.events', 'utf8')
    assert.ok(Number(after.match(/^oom_kill (\d+)$/m)[1]) > Number(before.match(/^oom_kill (\d+)$/m)[1]))
    console.log('runner-container: resident-memory OOM killed and leader reaped at synthetic 256 MiB cgroup bound')
  } else {
    const fill = `const fs = require('node:fs'); const fd = fs.openSync('fill', 'w'); const block = Buffer.alloc(1024 * 1024); try { while (true) fs.writeSync(fd, block) } catch (error) { console.log(error.code); process.exitCode = 2 } finally { fs.closeSync(fd) }`
    const result = await call(['-e', fill])
    assert.equal(result.exitCode, 2)
    assert.equal(result.stdout, 'ENOSPC\n')
    assert.deepEqual(await readdir('/tmp/artium-calls'), [])
    const fd = openSync('/tmp/full', 'w')
    try {
      const block = Buffer.alloc(1024 * 1024)
      assert.throws(() => { while (true) writeSync(fd, block) }, { code: 'ENOSPC' })
      assert.equal((await call(['-e', 'process.exit(0)'])).exitCode, 0)
    } finally {
      closeSync(fd)
      unlinkSync('/tmp/full')
    }
    mkdirSync('/tmp/inodes')
    try {
      assert.throws(() => {
        for (let index = 0; ; index++) mkdirSync(join('/tmp/inodes', String(index)))
      }, { code: 'ENOSPC' })
      await assert.rejects(call(['-e', 'process.exit(0)']), { code: 'TEMP_UNAVAILABLE' })
    } finally {
      rmSync('/tmp/inodes', { recursive: true })
    }
    assert.equal((await call(['-e', "process.stdout.write('ready')"])).stdout, 'ready')
    console.log('runner-container: 6 GiB memory, 192 tasks, 256 MiB tmpfs; byte and inode exhaustion; cleanup and next call passed')
  }
  assert.deepEqual(await readdir('/tmp/artium-calls'), [])
} finally {
  await runner.shutdown()
}
