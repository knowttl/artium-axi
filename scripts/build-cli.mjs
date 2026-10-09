import { build } from 'esbuild'

await build({ entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli/artium-axi.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22.12', loader: { '.md': 'text' }, banner: { js: '#!/usr/bin/env node' } })
