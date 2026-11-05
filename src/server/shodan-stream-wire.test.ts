import { expect, test } from 'vitest'
import { ShodanStreamWire, type ShodanWorkerMessage } from './shodan-stream-wire.js'

test('private frames survive arbitrary byte boundaries', () => {
  const messages: ShodanWorkerMessage[] = []
  const wire = new ShodanStreamWire(message => messages.push(message), 10)
  const frame = Buffer.from(JSON.stringify({ version: 1, type: 'event', requestId: 'one', event: { text: 'é' } }) + '\n')
  for (const byte of frame) wire.push(Buffer.from([byte]))
  wire.finish()
  expect(messages).toEqual([{ version: 1, type: 'event', requestId: 'one', event: { text: 'é' } }])
})

test.each([
  Buffer.from('{"version":1,"type":"ready","requestId":"a","extra":true}\n'),
  Buffer.from('{"version":2,"type":"ready","requestId":"a"}\n'),
  Buffer.from('{"version":1,"type":"unknown","requestId":"a"}\n'),
  Buffer.from([0xff, 0x0a]), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
])('malformed private frames are refused', frame => {
  const wire = new ShodanStreamWire(() => {}, 10)
  expect(() => wire.push(frame)).toThrow()
})

test('duplicate worker request identifiers are refused', () => {
  const wire = new ShodanStreamWire(() => {}, 10)
  const frame = Buffer.from('{"version":1,"type":"ready","requestId":"a"}\n')
  wire.push(frame)
  expect(() => wire.push(frame)).toThrow()
})
