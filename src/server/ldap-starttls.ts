import type { Socket } from 'node:net'

export const ldapStartTlsRequest = '301d02010177188016312e332e362e312e342e312e313436362e3230303337'

export function startLdapTls(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 2) return
      const lengthBytes = received[1] < 128 ? 0 : received[1] & 127
      if (received[0] !== 0x30 || lengthBytes > 2 || received.length > 4096 || received[1] === 128) {
        cleanup(); reject(new Error('Invalid StartTLS response')); return
      }
      if (received.length < 2 + lengthBytes) return
      const length = lengthBytes ? received.readUIntBE(2, lengthBytes) : received[1]
      const offset = 2 + lengthBytes
      if (length > 4096) { cleanup(); reject(new Error('Invalid StartTLS response')); return }
      if (received.length < offset + length) return
      cleanup()
      const applicationLengthBytes = received[offset + 4] < 128 ? 0 : received[offset + 4] & 127
      const result = offset + 5 + applicationLengthBytes
      if (received.subarray(offset, offset + 4).equals(Buffer.from([2, 1, 1, 0x78])) && applicationLengthBytes <= 2
        && received.subarray(result, result + 3).equals(Buffer.from([0x0a, 1, 0]))) resolve()
      else reject(new Error('StartTLS was rejected'))
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => onError(Object.assign(new Error('StartTLS connection closed'), { code: 'ECONNRESET' }))
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose) }
    socket.on('data', onData).once('error', onError).once('close', onClose)
    socket.write(Buffer.from(ldapStartTlsRequest, 'hex'))
  })
}
