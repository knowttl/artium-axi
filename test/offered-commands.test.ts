import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const { adoSurface, ghSurface, unadmittedCommands, unknownGhGroups } = await import(new URL('../scripts/offered-commands.mjs', import.meta.url).href)
const review = JSON.parse(readFileSync(new URL('../tools/offered-review.json', import.meta.url), 'utf8')) as Record<string, string[]>

test.each(Object.keys(review))('%s offers no command that is neither admitted, blocked nor reviewed in tools/offered-review.json', async tool => {
  expect(await unadmittedCommands(tool),
    `${tool} upstream commands changed: admit or block each new command in its inventory generator, or record the decision with pnpm offered:generate`)
    .toEqual(review[tool])
})

test('the pinned gh-axi offers no top-level group missing from the inventory group list', () => {
  expect(unknownGhGroups(), 'new upstream gh-axi group: admit it in scripts/gh-inventory.mjs or list it under blockedCommands').toEqual([])
})

test('a top-level gh-axi group absent from the inventory group list is reported with its commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-offered-'))
  try {
    const binary = join(directory, 'gh-axi.mjs')
    writeFileSync(binary, `const [first] = process.argv.slice(2)
console.log(first === '--help'
  ? 'usage: gh-axi [command] [args] [flags]\\ncommands[3]:\\n  (none)=dashboard, issue, agent-task'
  : \`usage: gh-axi \${first} <subcommand> [flags]\\nsubcommands[2]:\\n  list, view <number>\`)
`)
    chmodSync(binary, 0o755)
    expect(unknownGhGroups(binary)).toEqual(['agent-task'])
    expect(ghSurface(binary).offered).toEqual(['home', 'issue list', 'issue view', 'agent-task list', 'agent-task view'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an ado-axi verb that takes no arguments is reported as offered', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-offered-'))
  try {
    const helpModule = join(directory, 'help.mjs')
    writeFileSync(helpModule, `export const COMMAND_HELP = { cache: 'ado-axi cache\\n\\nlist  [--limit 30]\\nsync  refreshes the cache' }\n`)
    expect([...new Set((await adoSurface(pathToFileURL(helpModule))).offered)]).toEqual(['cache', 'cache list', 'cache sync'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
