import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'

const temporary = `dist/cli/.artium-axi-${randomUUID()}.mjs`
try {
  await build({ entryPoints: ['src/cli/main.ts'], outfile: temporary, bundle: true,
    platform: 'node', format: 'esm', target: 'node22.12', loader: { '.md': 'text' }, banner: { js: '#!/usr/bin/env node' } })
  renameSync(temporary, 'dist/cli/artium-axi.mjs')
} finally { rmSync(temporary, { force: true }) }
