import { createHash } from 'node:crypto'
import { fstatSync, readvSync, writeSync } from 'node:fs'
import { Socket } from 'node:net'
import { encode } from '@toon-format/toon'
import { ArtiumError } from '../shared/errors.js'
import { protectedResultLimits } from '../server/config.js'
import { DEFAULT_REQUEST_DEADLINE_MS, type Client } from './http.js'

export function privateDescriptor(value: string | undefined, readable = false): number {
  const fd = Number(value)
  try {
    if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(fd) || fd < 5) throw new Error('Invalid descriptor')
    const sink = fstatSync(fd)
    if (!sink.isFIFO() && !sink.isSocket()) throw new Error('Not a private pipe')
    for (const reserved of [0, 1, 2, 3, 4]) {
      let other: ReturnType<typeof fstatSync>
      try { other = fstatSync(reserved) } catch { continue }
      if (sink.dev === other.dev && sink.ino === other.ino) throw new Error('Reserved pipe')
    }
    writeSync(fd, Buffer.alloc(0))
    if (readable) readvSync(fd, [Buffer.alloc(0)])
  } catch { throw new ArtiumError('INVALID_INPUT', 'Supply an inherited writable private pipe on a descriptor of at least 5.') }
  return fd
}

export async function deliverPrivateResult(createClient: () => Client,
  result: { tool: 'kubernetes-axi' | 'proxmox-axi', operation: string, id: string, fd: string | undefined, json: boolean,
    maxBytes?: number, expected?: { bytes: number, sha256: string } },
  output: (text: string) => void): Promise<void> {
  const fd = privateDescriptor(result.fd)
  const client = createClient(), sink = new Socket({ fd, readable: false, writable: true })
  sink.on('error', () => {})
  const stop = () => { client.cancel(); sink.destroy() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    await client.authenticated('/v1/me', 'GET')
    await client.transferSession(token => client.artifact(`/v1/results/${result.tool}/${encodeURIComponent(result.operation)}/${result.id}`,
      undefined, token, '', Date.now() + DEFAULT_REQUEST_DEADLINE_MS, async (response, signal) => {
        const chunks: Buffer[] = []
        let size = 0
        try {
          for await (const chunk of response) {
            size += chunk.length
            if (size > (result.maxBytes ?? (result.tool === 'proxmox-axi' ? 65540 : protectedResultLimits.bytes))) throw new ArtiumError('INVALID_RESPONSE')
            chunks.push(chunk)
          }
          const bytes = Buffer.concat(chunks)
          try {
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            if (!bytes.length || response.headers['x-artium-content-sha256'] !== sha256
              || Number(response.headers['content-length']) !== bytes.length) throw new ArtiumError('INVALID_RESPONSE')
            if (result.expected && (result.expected.bytes !== bytes.length || result.expected.sha256 !== sha256)) throw new ArtiumError('INVALID_RESPONSE')
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
            output((result.json ? JSON.stringify : encode)({ id: result.id, delivery: 'private-pipe', bytes: bytes.length, sha256 }) + '\n')
          } finally { bytes.fill(0) }
        } finally { for (const chunk of chunks) chunk.fill(0) }
      }, 'GET'))
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); sink.destroy() }
}
