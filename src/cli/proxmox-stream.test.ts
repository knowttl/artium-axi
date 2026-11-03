import { afterEach, expect, test, vi } from 'vitest'
import { proxmoxStream } from './proxmox-stream.js'

const unconfigured = () => { throw new Error('Configuration must remain unread') }
afterEach(() => vi.unstubAllEnvs())

test.each([
  ['stream', '--help', '--json'], ['stream', '--json', '--help'],
].map(args => ({ args })))('managed stream help works before configuration: $args', async ({ args }) => {
  const output: string[] = []
  await proxmoxStream(unconfigured, args, (_stream, text) => output.push(text))
  const value = JSON.parse(output.join(''))
  expect(value.usage).toBe('artium-axi proxmox-axi stream -- transfer|duplex <native arguments>')
  expect(value.help).toContain('Execution requires PROXMOX_AXI_STREAM_FD on a private descriptor of at least 5. Duplex also requires a distinct PROXMOX_AXI_RESULT_FD.')
})

test('upload help exposes a local source without offering server credential overrides', async () => {
  const output: string[] = []
  await proxmoxStream(unconfigured, ['stream', '--json', '--', 'transfer', 'create', '/nodes/{node}/storage/{storage}/upload', '--help'],
    (_stream, text) => output.push(text))
  const value = JSON.parse(output.join(''))
  expect(value.flags['input-file']).toBe('absolute local source')
  expect(Object.keys(value.flags).filter(name => ['session', 'config', 'origin'].includes(name))).toEqual([])
})

test.each([
  ['stream'], ['stream', 'transfer', 'get', '/nodes/{node}/rrd'],
  ['stream', '--', 'auth', 'acquire'], ['stream', '--json', '--json', '--help'],
].map(args => ({ args })))('invalid stream syntax fails before authentication: $args', async ({ args }) => {
  await expect(proxmoxStream(unconfigured, args, () => {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('a standard-output byte descriptor is refused before authentication or dispatch', async () => {
  vi.stubEnv('PROXMOX_AXI_STREAM_FD', '1')
  await expect(proxmoxStream(unconfigured, ['stream', '--', 'transfer', 'get', '/nodes/{node}/rrd'], () => {}))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
