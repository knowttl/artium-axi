import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { fakeTool } from './fake-tool/tool.js'

const run = (args: string[], env = {}) => spawnSync(fakeTool.executable, [...fakeTool.args, ...args], {
  encoding: 'utf8', env, timeout: 3000,
})

test('fake executable prints exactly the supplied environment and arguments', () => {
  expect(JSON.parse(run(['env'], { CANARY: 'synthetic' }).stdout)).toEqual({ CANARY: 'synthetic' })
  expect(run(['print', '$(literal)', ';']).stdout).toBe('$(literal) ;')
})

test.each(['stdout', 'stderr'] as const)('flood fills %s with the requested byte count', (stream) => {
  const result = run([stream, '100000'])
  expect(result.status).toBe(0)
  expect(result[stream]).toBe('x'.repeat(100000))
  expect(result[stream === 'stdout' ? 'stderr' : 'stdout']).toBe('')
})

test.each(['stdout', 'stderr'] as const)('split preserves UTF-8 bytes in %s', (stream) => {
  const result = run(['split', 'canary-☃', '8', stream])
  expect(result.status).toBe(0)
  expect(result[stream]).toBe('canary-☃')
})

test.each([
  ['raw', 'CANARY+/='], ['base64', 'Q0FOQVJZKy89'],
  ['base64url', 'Q0FOQVJZKy89'], ['url', 'CANARY%2B%2F%3D'],
])('canary leak supports %s on either stream', (form, value) => {
  expect(run(['leak', form], { ARTIUM_TEST_CANARY: 'CANARY+/=' }).stdout).toBe(value)
  expect(run(['leak', form, 'stderr'], { ARTIUM_TEST_CANARY: 'CANARY+/=' }).stderr).toBe(value)
})

test('fake executable preserves exit status and signal termination', () => {
  expect(run(['exit', '17']).status).toBe(17)
  expect(run(['signal']).signal).toBe('SIGTERM')
  expect(run(['missing']).status).toBe(2)
})

test.each(['empty', 'error', 'suggestions'])('synthetic %s fixture is executable output', (name) => {
  const result = run(['fixture', name])
  expect(result.status).toBe(name === 'error' ? 1 : 0)
  expect(result.stdout).toContain(name === 'error' ? 'API_ERROR' : name === 'empty' ? 'count: 0' : 'help[2]')
})

test.each(['az-axi', 'vectra-axi', 'mg-axi'])('%s synthetic captures preserve streams and status', (tool) => {
  expect(run(['upstream', tool, 'empty']).status).toBe(0)
  expect(run(['upstream', tool, 'error']).status).toBe(1)
  expect(run(['upstream', tool, 'suggestions']).stdout).toContain(`Run \`${tool} `)
  expect(run(['upstream', tool, 'empty']).stderr).toBe('')
})

test('sleep remains alive until the requested timeout', () => {
  const result = run(['sleep', '60000'])
  expect(result.error?.message).toContain('ETIMEDOUT')
  expect(result.signal).toBe('SIGTERM')
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
