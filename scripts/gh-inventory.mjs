import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/gh-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot)))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root)))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for gh-axi')
// Reviewed published 0.1.44 dispatch and flag parsing. Only named reads enter
// the host boundary. Internal GraphQL query transport is separate from api.
const commands = []
function route(command, values = '', booleans = '', positionals = 0, repository = false) {
  commands.push({ command, effect: 'read', flags: { help: 'boolean', repo: 'value',
    ...Object.fromEntries(values.split(' ').filter(Boolean).map(name => [name, 'value'])),
    ...Object.fromEntries(booleans.split(' ').filter(Boolean).map(name => [name, 'boolean'])) }, positionals, repository })
}
route('home')
route('issue list', 'fields state label assignee author milestone sort limit search', '', 0, true)
route('issue view', '', 'comments full', 1, true)
route('issue subissue list', '', '', 1, true)
route('pr list', 'fields state label assignee author base head limit search', 'draft', 0, true)
route('pr view', '', 'comments reviews checks full', 1, true)
route('pr diff', '', 'full patch', 1, true)
route('pr checks', '', 'failed fail-fast', 1, true)
route('discussion list', 'state category author label limit', '', 0, true)
route('discussion view', 'limit order', 'comments full', 1, true)
route('run list', 'fields limit workflow branch status event user commit', '', 0, true)
route('run view', 'job conclusion', 'log verbose log-failed', 1, true)
route('workflow list', 'limit', 'all', 0, true)
route('workflow view', '', 'yaml', 1, true)
route('release list', 'limit', 'exclude-drafts exclude-pre-releases', 0, true)
route('release view', '', 'full', 1, true)
route('repo view', '', '', 1)
route('repo list', 'limit visibility language', 'archived', 1)
route('label list', 'limit', '', 0, true)
route('gist list', 'limit fields', 'public secret')
route('gist view', 'filename', 'full files raw', 1)
route('project list', 'owner limit', 'closed')
route('project view', 'owner', '', 1)
route('project item-list', 'owner query limit', '', 1)
route('project field-list', 'owner limit', '', 1)
route('secret list', 'env', '', 0, true)
route('variable list', '', '', 0, true)
route('search issues', 'owner state label assignee author sort limit fields', '', 'variadic')
route('search prs', 'owner state label assignee author sort limit review fields', 'draft', 'variadic')
route('search repos', 'owner language stars sort limit', '', 'variadic')
route('search commits', 'owner author sort limit', '', 'variadic')
route('search code', 'owner language limit', '', 'variadic')
route('api', 'jq template', 'paginate full', 2)
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function sources(directory, prefix) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    return entry.isDirectory() ? sources(path, `${prefix}${entry.name}/`)
      : entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, sha256: digest(path) }] : []
  })
}
const sdk = new URL('../axi-sdk-js/', pathToFileURL(realpathSync(packageRoot) + '/'))
const sdkPackage = JSON.parse(readFileSync(new URL('package.json', sdk)))
const sdkPin = JSON.parse(readFileSync(new URL('integrity.json', root)))['axi-sdk-js']
if (sdkPackage.version !== sdkPin.version) throw new Error('Pin mismatch for axi-sdk-js')
const data = { generatedBy: 'scripts/gh-inventory.mjs', tool: 'gh-axi', ...pin,
  parserEvidence: 'Hand-reviewed published dispatch switches and per-command parsers; writes excluded',
  skillSha256: digest(new URL('skills/gh-axi/SKILL.md', packageRoot)),
  sdk: { ...sdkPin, manifestSha256: digest(new URL('package.json', sdk)) },
  gh: JSON.parse(readFileSync(new URL('gh-source.json', root))),
  sources: [...sources(new URL('dist/', packageRoot), 'dist/'), ...sources(new URL('dist/', sdk), 'axi-sdk-js/dist/')],
  adapterBoundary: { unsafeOverrides: ['hostname', 'watch', 'attach', 'body-file', 'notes-file', 'input', 'file', 'add', 'field', 'raw-field', 'header'],
    blockedCommands: ['update', 'setup', 'stack', 'pr checkout', 'repo clone', 'gist clone', 'run watch', 'run download', 'release download'],
    nativeWrites: 'blocked', inputs: { stdin: 'unsupported', files: 'unsupported' } },
  discovery: { commands: [...new Set(commands.map(route => route.command.split(' ')[0]))].filter(name => name !== 'home'),
    example: ['repo', 'list', '--limit', '1'],
    help: 'gh-axi repo list [<owner>] [--limit <n>]\nManaged read-only GitHub API access. Use -R OWNER/NAME for repository reads. api accepts [GET] <relative-path>; GraphQL and all writes are refused. No stdin or files.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
const destination = new URL('inventories/gh-axi.json', root)
const contents = JSON.stringify(data, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: gh-axi; review the pinned commands and effects')
console.log(`inventory: gh-axi ${pkg.version}, ${commands.length} commands`)
