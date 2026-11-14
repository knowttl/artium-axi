import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const adminClientDirectory = 'src/server/admin/client'

export async function buildAdminClient(directory = adminClientDirectory) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  await build({ entryPoints: ['src/client/hydrate.tsx'], outfile: join(directory, 'hydrate.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const stylesheets = ['@astryxdesign/core/src/reset.css', '@astryxdesign/core/dist/astryx.css', '@astryxdesign/theme-neutral/dist/theme.css']
  writeFileSync(join(directory, 'astryx.css'), stylesheets.map(path => readFileSync(join('node_modules', path), 'utf8')).join('\n'))
}

if (import.meta.url === `file://${process.argv[1]}`) await buildAdminClient()
