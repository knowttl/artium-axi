import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const adminClientDirectory = 'src/server/admin/client'

export async function buildAdminClient(directory = adminClientDirectory) {
  mkdirSync(directory, { recursive: true })
  const staging = mkdtempSync(join(dirname(directory), `.${basename(directory)}-build-`))
  try {
    await build({ entryPoints: ['src/client/hydrate.tsx'], outfile: join(staging, 'hydrate.js'), bundle: true, minify: true,
      platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
    const stylesheets = ['@astryxdesign/core/src/reset.css', '@astryxdesign/core/dist/astryx.css', '@astryxdesign/theme-neutral/dist/theme.css']
    writeFileSync(join(staging, 'astryx.css'), stylesheets.map(path => readFileSync(join('node_modules', path), 'utf8')).join('\n'))
    for (const name of ['hydrate.js', 'astryx.css']) renameSync(join(staging, name), join(directory, name))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildAdminClient()
