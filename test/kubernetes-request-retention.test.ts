import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { retainKubernetesRequests } from '../src/server/runner/kubernetes-requests.js'

test('Kubernetes retention removes only recognized scopes inactive beyond ninety days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artium-kubernetes-retention-'))
  const now = Date.UTC(2026, 10, 1)
  const cutoff = now - 90 * 24 * 60 * 60 * 1000
  try {
    for (const [name, time] of [['a'.repeat(64), cutoff - 1], ['b'.repeat(64), cutoff], ['unrecognized', cutoff - 1]] as const) {
      const directory = join(root, name)
      await mkdir(join(directory, 'requests'), { recursive: true })
      await writeFile(join(directory, 'requests', 'request.json'), '{"state":"complete"}')
      await utimes(directory, new Date(time), new Date(time))
    }
    await retainKubernetesRequests(root, now)
    expect((await readdir(root)).sort()).toEqual(['b'.repeat(64), 'unrecognized'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
