import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const output = process.argv[2] ?? 'dist/cli/artium-axi.mjs'
const temporary = join(dirname(output), `.artium-axi-${randomUUID()}.mjs`)
try {
  await build({ entryPoints: ['src/cli/main.ts'], outfile: temporary, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' }, banner: { js: '#!/usr/bin/env node' } })
  renameSync(temporary, output)
} finally { rmSync(temporary, { force: true }) }
