import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { fakeTool } from './fake-tool/tool.js'

const run = (args: string[], env = {}) => spawnSync(fakeTool.executable, [...fakeTool.args, ...args], {
  encoding: 'utf8', env, timeout: 3000,
})

test.each([
  ['raw', 'CANARY+/='], ['base64', 'Q0FOQVJZKy89'],
  ['base64url', 'Q0FOQVJZKy89'], ['url', 'CANARY%2B%2F%3D'],
])('canary leak supports %s on either stream', (form, value) => {
  expect(run(['leak', form], { ARTIUM_TEST_CANARY: 'CANARY+/=' }).stdout).toBe(value)
  expect(run(['leak', form, 'stderr'], { ARTIUM_TEST_CANARY: 'CANARY+/=' }).stderr).toBe(value)
})

test.each(['child', 'descendant', 'memory'])('%s fixture stays alive and can be cleaned up', async (mode) => {
  const child = spawn(fakeTool.executable, [...fakeTool.args, mode, '4'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let descendant: number | undefined
  try {
    const [chunk] = await once(child.stdout, 'data')
    const output = JSON.parse(chunk.toString())
    if (mode === 'memory') expect(output.bytes).toBe(4 * 1024 * 1024)
    else {
      descendant = output.child
      expect(output.detached).toBe(mode === 'descendant')
      expect(() => process.kill(descendant!, 0)).not.toThrow()
    }
    expect(child.exitCode).toBeNull()
  } finally {
    const closed = once(child, 'close')
    if (descendant) process.kill(descendant, 'SIGTERM')
    child.kill('SIGTERM')
    await closed
  }
})
