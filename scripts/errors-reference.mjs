import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: ['src/shared/errors.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { errors } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const contents = '# Error reference\n\nGenerated from `src/shared/errors.ts` by `pnpm errors:generate`.\nDo not edit manually.\nArtium errors use TOON on CLI stdout and JSON over HTTP.\nCompleted upstream calls preserve stdout, stderr and the upstream exit code, with HTTP 200 and the upstream tool as source.\nGraph sign-in failures include the category, token-acquisition stage, check time, credential revision and redacted tool message in administrator credential diagnostics.\nThey do not carry the provider (AADSTS) code because mg-axi does not expose it yet.\nAzure token-acquisition diagnostics retain supported provider codes.\n\n| Code | Source | HTTP | CLI exit | Message | Next step |\n|---|---|---|---|---|---|\n' +
  Object.entries(errors).map(([code, error]) => `| ${code} | ${error.source} | ${error.status} | ${error.exitCode} | ${error.message.replaceAll('|', '\\|')} | ${error.next.replaceAll('|', '\\|')} |`).join('\n') + '\n'
const path = new URL('../docs/errors.md', import.meta.url)
if (process.argv.includes('--write')) writeFileSync(path, contents)
else if (readFileSync(path, 'utf8') !== contents) throw new Error('docs/errors.md is stale. Run pnpm errors:generate.')
console.log(`errors: ${Object.keys(errors).length} catalogue entries, reference current`)
