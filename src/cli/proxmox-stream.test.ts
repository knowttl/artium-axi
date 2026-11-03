import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { Client } from './http.js'
import { privateDescriptor } from './private-result.js'
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

async function withFifo(run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(process.cwd(), '.stream-test-'))
  try {
    const path = join(directory, 'source')
    execFileSync('mkfifo', [path])
    await run(path)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test.skipIf(process.platform === 'win32').each(inventory.streamCommands.filter(route => route.command.startsWith('duplex ')))(
  'write-only duplex channels fail before admission: $command', async route => {
    await withFifo(async path => {
      const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
      const writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
      try {
        vi.stubEnv('PROXMOX_AXI_STREAM_FD', String(writer))
        await expect(proxmoxStream(unconfigured, ['stream', '--', ...route.command.split(' ')], () => {}))
          .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      } finally { closeSync(writer); closeSync(reader) }
    })
  })

test.skipIf(process.platform === 'win32')('duplex validation preserves queued bytes and permits writes', async () => {
  await withFifo(async path => {
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK)
    try {
      writeSync(fd, Buffer.from('before'))
      const validated = privateDescriptor(String(fd), true)
      writeSync(validated, Buffer.from('after'))
      const bytes = Buffer.alloc(11)
      expect(readSync(fd, bytes, 0, bytes.length, null)).toBe(11)
      expect(bytes.toString()).toBe('beforeafter')
    } finally { closeSync(fd) }
  })
})

test.skipIf(process.platform === 'win32').each([true, false])('upload rejects an idle FIFO before admission (preview=%s)', async preview => {
  await withFifo(async path => {
    const args = ['stream', '--', 'transfer', 'create', '/nodes/{node}/storage/{storage}/upload', '--input-file', path,
      ...(preview ? ['--preview'] : ['--confirm', 'synthetic-confirmation'])]
    execFileSync('mkfifo', [path + '.sink'])
    const sink = openSync(path + '.sink', constants.O_RDWR | constants.O_NONBLOCK)
    try {
      vi.stubEnv('PROXMOX_AXI_STREAM_FD', String(sink))
      await expect(proxmoxStream(() => new Client({ ARTIUM_AXI_URL: 'https://synthetic.invalid', ARTIUM_AXI_CA_FILE: '',
        XDG_CONFIG_HOME: process.cwd() }), args, () => {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } finally { closeSync(sink) }
  })
})
