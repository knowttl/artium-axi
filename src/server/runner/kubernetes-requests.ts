import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export async function kubernetesRequestProfile(root: string, scope: string, call: string): Promise<string> {
  if (!isAbsolute(root) || !/^[a-f0-9]{64}$/.test(scope) || !/^artium-call-[A-Za-z0-9]+$/.test(call)) {
    throw new TypeError('Invalid managed Kubernetes request scope')
  }
  const directory = join(root, scope)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  return join(directory, `${call}.json`)
}

export async function retainKubernetesRequests(root: string, now = Date.now()): Promise<void> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
    const directory = join(root, entry.name)
    // Token families expire within twelve hours; ninety-day inactive scopes cannot be live.
    if ((await lstat(directory)).mtimeMs < now - 90 * 24 * 60 * 60 * 1000) await rm(directory, { recursive: true })
  }
}
