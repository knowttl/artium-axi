import { build } from 'esbuild'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    const figtreeWeights = [400, 500, 600, 700]
    const figtreeFaces = figtreeWeights.map(weight => `@font-face{font-family:Figtree;font-style:normal;font-weight:${weight};font-display:swap;src:url(fonts/figtree-${weight}.woff2) format('woff2')}`)
    writeFileSync(join(staging, 'astryx.css'), [...stylesheets.map(path => readFileSync(join('node_modules', path), 'utf8')), ...figtreeFaces].join('\n'))
    mkdirSync(join(staging, 'fonts'))
    for (const weight of figtreeWeights) copyFileSync(`node_modules/@fontsource/figtree/files/figtree-latin-${weight}-normal.woff2`, join(staging, `fonts/figtree-${weight}.woff2`))
    copyFileSync('node_modules/@fontsource/figtree/LICENSE', join(staging, 'fonts/figtree-OFL.txt'))
    rmSync(join(directory, 'fonts'), { recursive: true, force: true })
    for (const name of ['hydrate.js', 'astryx.css', 'fonts']) renameSync(join(staging, name), join(directory, name))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildAdminClient()
