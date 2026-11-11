import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pins = JSON.parse(readFileSync(new URL('../tools/package.json', import.meta.url), 'utf8')).dependencies
const stale = Object.entries(pins).flatMap(([name, pinned]) => {
  const latest = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 60_000 }).trim()
  return latest === pinned ? [] : [{ name, pinned, latest }]
})
for (const { name, pinned, latest } of stale) console.log(`stale pin: ${name} is pinned at ${pinned}, npm latest is ${latest}`)
console.log(`pin freshness: ${Object.keys(pins).length} pins checked, ${stale.length} stale`)
if (stale.length) {
  console.log('Review each newer release, re-pin tools/package.json and regenerate the inventories; pnpm test then names every new upstream command that needs an admit or block decision.')
  process.exitCode = 1
}
