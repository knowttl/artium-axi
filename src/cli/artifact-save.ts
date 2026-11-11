import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { ArtiumError } from '../shared/errors.js'
import type { transferArchiveSchema } from '../shared/api.js'
import type { z } from 'zod'

async function privateParent(destination: string): Promise<FileHandle> {
  let parent = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of dirname(destination).split('/').filter(Boolean)) {
      const child = await open(`/proc/self/fd/${parent.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await parent.close()
      parent = child
    }
    const info = await parent.stat()
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new ArtiumError('ARTIFACT_SAVE_FAILED')
    return parent
  } catch (error) { await parent.close(); throw error }
}

// Linux directory descriptors keep all subsequent operations relative to the
// checked private directory. No artifact path is ever followed through a symlink.
export async function artifactDestination(destination: string) {
  if (process.platform !== 'linux' || !isAbsolute(destination) || resolve(destination) !== destination || basename(destination) === '') {
    throw new ArtiumError('ARTIFACT_SAVE_FAILED')
  }
  let parent: FileHandle
  try { parent = await privateParent(destination) }
  catch { throw new ArtiumError('ARTIFACT_SAVE_FAILED') }
  let temporary: string | undefined
  let file: FileHandle | undefined
  let closed = false
  try {
    const info = await parent.stat()
    const target = `/proc/self/fd/${parent.fd}/${basename(destination)}`
    // Fail before native execution when the confirmed new destination exists.
    try {
      const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      await existing.close()
      throw new ArtiumError('ARTIFACT_SAVE_FAILED')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const receive = async (response: IncomingMessage, expected: { contentType: string, digestHeader: string, bytes: number, sha256: string }, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (response.headers['content-type'] !== expected.contentType
        || response.headers['content-length'] !== String(expected.bytes)
        || response.headers[expected.digestHeader] !== expected.sha256
        || response.headers['content-encoding'] || response.headers['content-range']) throw new ArtiumError('INVALID_RESPONSE')
      temporary = `/proc/self/fd/${parent.fd}/.artium-${randomUUID()}.tmp`
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of response) {
        signal.throwIfAborted()
        size += chunk.length
        if (size > expected.bytes) throw new ArtiumError('INVALID_RESPONSE')
        hash.update(chunk)
        await file.writeFile(chunk)
      }
      if (size !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new ArtiumError('INVALID_RESPONSE')
      await file.sync()
      await file.close()
      file = undefined
      const current = await privateParent(destination)
      try {
        const actual = await current.stat()
        if (info.dev !== actual.dev || info.ino !== actual.ino) throw new ArtiumError('ARTIFACT_SAVE_FAILED')
      } finally { await current.close() }
      // link is atomic and fails if any entry, including a symlink, exists.
      // rename would silently overwrite the destination.
      signal.throwIfAborted()
      await link(temporary, target)
    }
    return {
      async saveBytes(bytes: Uint8Array) {
        temporary = `/proc/self/fd/${parent.fd}/.artium-${randomUUID()}.tmp`
        file = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await file.writeFile(bytes)
        await file.sync()
        const written = Buffer.alloc(bytes.length)
        try {
          const read = await file.read(written, 0, written.length, 0)
          if (read.bytesRead !== bytes.length || !written.equals(bytes)) throw new ArtiumError('ARTIFACT_SAVE_FAILED')
        } finally { written.fill(0) }
        await file.close(); file = undefined
        const current = await privateParent(destination)
        try {
          const actual = await current.stat()
          if (info.dev !== actual.dev || info.ino !== actual.ino) throw new ArtiumError('ARTIFACT_SAVE_FAILED')
        } finally { await current.close() }
        await link(temporary, target)
      },
      save(response: IncomingMessage, archive: z.infer<typeof transferArchiveSchema>, signal: AbortSignal) {
        return receive(response, { contentType: 'application/octet-stream', digestHeader: 'x-artium-archive-sha256',
          bytes: archive.archiveBytes, sha256: archive.archiveSha256 }, signal)
      },
      saveExport(response: IncomingMessage, expected: { bytes: number, sha256: string }, signal: AbortSignal) {
        return receive(response, { contentType: 'application/gzip', digestHeader: 'x-artium-export-sha256', ...expected }, signal)
      },
      async close() {
        if (closed) return
        closed = true
        try { await file?.close() }
        finally {
          try { if (temporary) await unlink(temporary) }
          finally { await parent.close() }
        }
      },
    }
  } catch {
    await parent.close()
    throw new ArtiumError('ARTIFACT_SAVE_FAILED')
  }
}
