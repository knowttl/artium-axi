import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { artifactDestination } from './artifact-save.js'
import { Client } from './http.js'

let root: string
let url: string
let server: ReturnType<typeof createServer>
let variant: string
const bytes = Buffer.from([0, 255, 128, 1])
const archive = { archiveBytes: bytes.length, archiveSha256: createHash('sha256').update(bytes).digest('hex') }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-private-save-'))
  variant = 'success'
  server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the synthetic request. */ }
    response.writeHead(200, { 'content-type': 'application/octet-stream',
      'content-length': variant === 'size' ? 5 : bytes.length,
      'x-artium-archive-sha256': variant === 'header-digest' ? 'a'.repeat(64) : archive.archiveSha256,
      ...(variant === 'encoding' ? { 'content-encoding': 'gzip' } : {}) })
    if (variant === 'disconnect') {
      response.write(bytes.subarray(0, 1))
      response.socket!.destroy()
    } else response.end(variant === 'digest' ? Buffer.alloc(bytes.length, 7) : bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(root, { recursive: true, force: true })
})
async function save(destination: Awaited<ReturnType<typeof artifactDestination>>) {
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: root })
  await client.artifact('/synthetic', {}, 'CANARY-token', 'CANARY-ticket', Date.now() + 10000,
    (response, signal) => {
      if (variant === 'cancel-after-bytes') response.once('end', () => client.cancel())
      return destination.save(response, archive, signal)
    })
}

test.each(['size', 'digest', 'header-digest', 'encoding', 'disconnect', 'cancel-after-bytes'])('rejects %s without publishing or retaining temporary bytes', async failure => {
  variant = failure
  const destination = await artifactDestination(join(root, 'new.bin'))
  try { await expect(save(destination)).rejects.toThrow() }
  finally { await destination.close() }
  expect(await readdir(root)).toEqual([])
})

test.each(['file', 'symlink'])('publication cannot overwrite a competing %s created after confirmation', async kind => {
  const destination = await artifactDestination(join(root, 'new.bin'))
  if (kind === 'file') await writeFile(join(root, 'new.bin'), 'sentinel')
  else { await writeFile(join(root, 'sentinel'), 'sentinel'); await symlink(join(root, 'sentinel'), join(root, 'new.bin')) }
  try { await expect(save(destination)).rejects.toThrow() }
  finally { await destination.close() }
  expect(await readFile(join(root, 'new.bin'), 'utf8')).toBe('sentinel')
  expect((await readdir(root)).some(name => name.startsWith('.artium-'))).toBe(false)
})

test('private save rejects a general directory', async () => {
  await mkdir(join(root, 'shared'), { mode: 0o755 })
  await expect(artifactDestination(join(root, 'shared', 'new.bin'))).rejects.toMatchObject({ code: 'ARTIFACT_SAVE_FAILED' })
})

test('changed parent identity or a replacement symlink cannot redirect publication', async () => {
  await mkdir(join(root, 'downloads'), { mode: 0o700 })
  await mkdir(join(root, 'other'), { mode: 0o700 })
  const destination = await artifactDestination(join(root, 'downloads', 'new.bin'))
  await rename(join(root, 'downloads'), join(root, 'moved'))
  await symlink(join(root, 'other'), join(root, 'downloads'))
  try { await expect(save(destination)).rejects.toThrow() }
  finally { await destination.close() }
  expect(await readdir(join(root, 'moved'))).toEqual([])
  expect(await readdir(join(root, 'other'))).toEqual([])
})
