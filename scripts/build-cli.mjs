import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const output = process.argv[2] ?? 'dist/cli/artium-axi.mjs'
const temporary = join(dirname(output), `.artium-axi-${randomUUID()}.mjs`)
const sshLicense = readFileSync('tools/node_modules/@knowttl/ssh-axi/LICENSE', 'utf8')
try {
  await build({ entryPoints: ['src/cli/main.ts'], outfile: temporary, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' }, banner: { js: `#!/usr/bin/env node\n/* Bundled @knowttl/ssh-axi argument parser\n${sshLicense}*/` } })
  renameSync(temporary, output)
} finally { rmSync(temporary, { force: true }) }
