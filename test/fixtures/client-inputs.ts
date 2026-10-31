import { chmodSync, copyFileSync } from 'node:fs'
import { inject } from 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    clientInputs: { bundle: string, tarball: string }
  }
}

// Only private copies leave this boundary; installs and tests may mutate them.
export function copyClientInput(input: 'bundle' | 'tarball', destination: string) {
  copyFileSync(inject('clientInputs')[input], destination)
  chmodSync(destination, 0o644)
  return destination
}
