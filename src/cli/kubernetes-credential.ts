import { createHash } from 'node:crypto'
import { fstatSync, writeSync } from 'node:fs'
import { Socket } from 'node:net'
import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { protectedResultLimits } from '../server/config.js'
import { DEFAULT_REQUEST_DEADLINE_MS, type Client } from './http.js'

export async function kubernetesCredential(createClient: () => Client, supplied: string[], output: (text: string) => void) {
  const json = supplied.includes('--json'), args = supplied.filter(arg => arg !== '--json')
  const print = (value: unknown) => output((json ? JSON.stringify(value) : encode(value)) + '\n')
  if (args.length === 2 && args[1] === '--help') {
    print({ usage: 'artium-axi kubernetes-axi credential <result-id> --credential-fd <private-pipe-fd>',
      help: ['Retrieve a token-create result once, within five minutes, using the same caller and sign-in family.',
        'Use an inherited writable private pipe distinct from stdin, stdout, stderr and reserved session descriptors 3 and 4.',
        'No token bytes enter routine output or files. An interrupted delivery is never retried.'] })
    return true
  }
  if (args.length !== 4 || !z.uuid().safeParse(args[1]).success || args[2] !== '--credential-fd'
    || !/^[1-9][0-9]*$/.test(args[3]) || !Number.isSafeInteger(Number(args[3])) || Number(args[3]) < 5) throw new ArtiumError('INVALID_INPUT')
  const fd = Number(args[3])
  try {
    const sink = fstatSync(fd)
    if (!sink.isFIFO() && !sink.isSocket()) throw new Error('Not a private pipe')
    for (const reserved of [0, 1, 2, 3, 4]) {
      let other: ReturnType<typeof fstatSync>
      try { other = fstatSync(reserved) } catch { continue }
      if (sink.dev === other.dev && sink.ino === other.ino) throw new Error('Reserved pipe')
    }
    writeSync(fd, Buffer.alloc(0))
  } catch { throw new ArtiumError('INVALID_INPUT', 'Supply an inherited writable private pipe on a descriptor of at least 5.') }
  const client = createClient()
  const sink = new Socket({ fd, readable: false, writable: true })
  sink.on('error', () => {})
  const stop = () => { client.cancel(); sink.destroy() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    await client.authenticated('/v1/me', 'GET')
    await client.transferSession(token => client.artifact(`/v1/results/kubernetes-axi/token-create/${args[1]}`,
      undefined, token, '', Date.now() + DEFAULT_REQUEST_DEADLINE_MS, async (response, signal) => {
        const chunks: Buffer[] = []
        let size = 0
        try {
          for await (const chunk of response) {
            size += chunk.length
            if (size > protectedResultLimits.bytes) throw new ArtiumError('INVALID_RESPONSE')
            chunks.push(chunk)
          }
          const bytes = Buffer.concat(chunks)
          try {
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            if (!bytes.length || response.headers['x-artium-content-sha256'] !== sha256
              || Number(response.headers['content-length']) !== bytes.length) throw new ArtiumError('INVALID_RESPONSE')
            await new Promise<void>((resolve, reject) => {
              const cancel = () => sink.destroy(new ArtiumError('CANCELLED'))
              if (signal.aborted) { reject(new ArtiumError('CANCELLED')); return }
              signal.addEventListener('abort', cancel, { once: true })
              sink.write(bytes, error => {
                signal.removeEventListener('abort', cancel)
                if (error) reject(new ArtiumError('TEMP_UNAVAILABLE', 'Private delivery failed; the one-time result may have been consumed. No request was retried.'))
                else resolve()
              })
            })
            print({ id: args[1], delivery: 'private-pipe', bytes: bytes.length, sha256 })
          } finally { bytes.fill(0) }
        } finally { for (const chunk of chunks) chunk.fill(0) }
      }, 'GET'))
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); sink.destroy() }
  return true
}
