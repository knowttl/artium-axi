import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { ProxmoxFrameMeter } from './proxmox-stream.js'

test.each([1, 2, 3, 4, 5, 9, 65536])('native frame accounting preserves messages split every %i bytes', size => {
  const first = Buffer.from([0, 255, 13, 10]), last = Buffer.from('final-peer-message')
  const a = Buffer.alloc(4), b = Buffer.alloc(4)
  a.writeUInt32BE(first.length); b.writeUInt32BE(last.length)
  const wire = Buffer.concat([a, first, b, last]), meter = new ProxmoxFrameMeter(1048576)
  for (let offset = 0; offset < wire.length; offset += size) meter.add(wire.subarray(offset, offset + size))
  expect(meter.finish()).toEqual({ bytes: first.length + last.length, frames: 2,
    sha256: createHash('sha256').update(Buffer.concat([first, last])).digest('hex') })
})

test.each([
  { label: 'oversized message', bytes: Buffer.from([0, 16, 0, 1]), limit: 2097152 },
  { label: 'direction quota', bytes: Buffer.from([0, 0, 0, 5]), limit: 4 },
  { label: 'partial header', bytes: Buffer.from([0, 0, 0]), limit: 1048576 },
  { label: 'partial payload', bytes: Buffer.from([0, 0, 0, 2, 1]), limit: 1048576 },
])('native frame validation refuses $label', ({ bytes, limit }) => {
  const meter = new ProxmoxFrameMeter(limit)
  expect(() => { meter.add(bytes); meter.finish() }).toThrow()
})
