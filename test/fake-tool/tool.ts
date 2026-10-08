import { fileURLToPath } from 'node:url'

// Tests register this descriptor explicitly. Production has no fake registry entry.
export const fakeTool = {
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fake-axi.mjs', import.meta.url))],
}
