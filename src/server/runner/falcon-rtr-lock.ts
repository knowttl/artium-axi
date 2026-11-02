import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ArtiumError } from '../../shared/errors.js'

// The published adapter verifies its native binary before retaining the lock.
export async function acquireFalconRtrLock(root: string, executable: string, device: string): Promise<{ close(): void }> {
  if (!/^[a-f0-9]{32}$/.test(device)) throw new ArtiumError('INVALID_INPUT')
  try {
    const adapter: unknown = await import(pathToFileURL(join(dirname(await realpath(executable)), 'rtr-filesystem.js')).href)
    if (!adapter || typeof adapter !== 'object' || !('openRetainedFile' in adapter) || typeof adapter.openRetainedFile !== 'function') {
      throw new ArtiumError('TEMP_UNAVAILABLE')
    }
    const open = adapter.openRetainedFile as (path: string, locked: boolean) => { close(): void }
    return open(join(root, 'falcon-rtr-locks', `rtr-${device}.lock`), true)
  }
  catch { throw new ArtiumError('TEMP_UNAVAILABLE', 'Another RTR run holds this device or its private lock is unavailable') }
}
