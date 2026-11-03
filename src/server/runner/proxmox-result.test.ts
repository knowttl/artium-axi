import { expect, test } from 'vitest'
import { proxmoxResult } from './proxmox-result.js'

const binding = { origin: 'https://synthetic.invalid', identity: 'automation@pve', operation: 'OP-POST-774b7e437e',
  request: 'synthetic-request', actor: 'synthetic-actor', credentialRevision: 'synthetic:1' }
function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.length)
  return Buffer.concat([header, bytes])
}

test('S4 frame preserves private payload and identifies minted values without registering metadata', () => {
  const payload = { status: 'success', items: [{ value: 'a' }, { recovery: ['success', 'CANARY-recovery'] }] }
  expect(proxmoxResult(frame({ version: 1, binding, payload }), binding)).toEqual({ payload,
    secrets: ['a', 'success', 'CANARY-recovery'] })
})

test.each(Object.keys(binding) as (keyof typeof binding)[])('S4 frame refuses a mismatched %s binding', key => {
  expect(() => proxmoxResult(frame({ version: 1, binding: { ...binding, [key]: 'different' }, payload: {} }), binding))
    .toThrow(expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }))
})

test.each([
  { name: 'version', value: { version: 2, binding, payload: {} } },
  { name: 'missing payload', value: { version: 1, binding } },
  { name: 'extra field', value: { version: 1, binding, payload: {}, extra: true } },
])('S4 frame refuses invalid envelope $name', ({ value }) => {
  expect(() => proxmoxResult(frame(value), binding)).toThrow(expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }))
})

test.each([
  { name: 'empty', bytes: Buffer.alloc(0) },
  { name: 'truncated', bytes: Buffer.from([0, 0, 0, 3, 123]) },
  { name: 'multiple frames', bytes: Buffer.concat([frame({ version: 1, binding, payload: {} }), frame({ version: 1, binding, payload: {} })]) },
  { name: 'oversized', bytes: frame({ version: 1, binding, payload: 'x'.repeat(65536) }) },
])('S4 frame refuses $name bytes', ({ bytes }) => {
  expect(() => proxmoxResult(bytes, binding)).toThrow(expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }))
})
