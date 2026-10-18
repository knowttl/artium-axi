import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:tls'

// Minimal synthetic LDAP: accept a bind and return an empty successful root search.
export function createLdapService(directory) {
  return createServer({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) }, socket => {
    let pending = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const lengthBytes = pending[1] < 128 ? 0 : pending[1] & 127
        if (pending.length < 2 + lengthBytes) return
        const length = lengthBytes ? pending.readUIntBE(2, lengthBytes) : pending[1]
        const offset = 2 + lengthBytes
        if (pending.length < offset + length) return
        const message = pending.subarray(offset, offset + length)
        pending = pending.subarray(offset + length)
        const idLength = message[1]
        const id = message.subarray(0, 2 + idLength)
        const operation = message[2 + idLength]
        if (operation === 0x42) { socket.end(); return }
        if (operation !== 0x60 && operation !== 0x63) { socket.destroy(); return }
        const response = Buffer.concat([id, Buffer.from([operation === 0x60 ? 0x61 : 0x65,
          7, 0x0a, 1, 0, 4, 0, 4, 0])])
        socket.write(Buffer.concat([Buffer.from([0x30, response.length]), response]))
      }
    })
  })
}
