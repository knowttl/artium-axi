import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/gh-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot)))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root)))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for gh-axi')
// Reviewed published 0.1.44 dispatch and flag parsing. Internal GraphQL query
// transport is separate from the caller-facing GET-only api route.
const commands = []
function route(command, values = '', booleans = '', positionals = 0, repository = false) {
  commands.push({ command, effect: 'read', flags: { help: 'boolean', ...repository ? { repo: 'value' } : {},
    ...Object.fromEntries(values.split(' ').filter(Boolean).map(name => [name, 'value'])),
    ...Object.fromEntries(booleans.split(' ').filter(Boolean).map(name => [name, 'boolean'])) }, positionals, repository })
}
route('issue list', 'fields state label assignee author milestone sort limit', '', 0, true)
route('issue view', '', 'comments full', 1, true)
route('issue subissue list', '', '', 1, true)
route('pr list', 'fields state label assignee author base head limit', 'draft', 0, true)
route('pr view', '', 'comments reviews checks full', 1, true)
route('pr diff', '', 'full', 1, true)
route('pr checks', '', 'failed', 1, true)
route('discussion list', 'state category author label limit', '', 0, true)
route('discussion view', 'limit order', 'comments full', 1, true)
route('run list', 'fields limit workflow branch status event user commit', '', 0, true)
route('run view', 'job conclusion', 'log verbose log-failed', 1, true)
route('workflow list', 'limit', 'all', 0, true)
route('workflow view', '', 'yaml', 1, true)
route('release list', 'limit', 'exclude-drafts exclude-pre-releases', 0, true)
route('release view', '', 'full', 1, true)
route('repo view', '', '', 0, true)
route('repo list', 'limit visibility language', 'archived', 1)
route('label list', 'limit', '', 0, true)
route('gist list', 'limit fields', 'public secret')
route('gist view', 'filename', 'full files', 1)
route('project list', 'repo owner limit', 'closed')
route('project view', 'repo owner', '', 1)
route('project item-list', 'repo owner query limit', '', 1)
route('project field-list', 'repo owner limit', '', 1)
route('secret list', 'env', '', 0, true)
route('variable list', '', '', 0, true)
route('search issues', 'repo owner state label assignee author sort limit fields', '', 'variadic')
route('search prs', 'repo owner state label assignee author sort limit review fields', 'draft', 'variadic')
route('search repos', 'owner language stars sort limit', '', 'variadic')
route('search commits', 'repo owner author sort limit', '', 'variadic')
route('search code', 'repo owner language limit', '', 'variadic')
route('api', 'jq template', 'paginate full', 2)
function write(command, tier, values = '', booleans = '', positionals = 1, repository = true) {
  route(command, values, booleans, positionals, repository)
  Object.assign(commands.at(-1), { effect: 'write', tier })
  commands.at(-1).flags.confirm = 'value'
}
write('issue create', 'collaboration', 'title body assignee label milestone project type', '', 0)
write('issue edit', 'collaboration', 'title body add-label remove-label add-assignee remove-assignee milestone type', 'no-type')
write('issue comment', 'collaboration', 'body')
write('issue close', 'collaboration', 'reason duplicate-of comment')
write('issue reopen', 'collaboration')
write('pr create', 'collaboration', 'title body base head assignee reviewer label milestone project', 'draft', 0)
write('pr edit', 'collaboration', 'title body add-label remove-label add-assignee remove-assignee add-reviewer remove-reviewer milestone base')
write('pr comment', 'collaboration', 'body')
write('pr ready', 'collaboration', '', 'undo')
write('pr review', 'collaboration', 'body match-head-commit', 'approve request-changes comment')
write('discussion comment', 'collaboration', 'body')
write('label create', 'collaboration', 'name color description', '', 0)
write('label edit', 'collaboration', 'name color description')
write('project item-add', 'collaboration', 'owner url', '', 1, false)
write('project item-create', 'collaboration', 'owner title body', '', 1, false)
write('project item-edit', 'collaboration', 'id project-id field-id text number date single-select-option-id iteration-id title body', 'clear', 0, false)
write('project item-archive', 'collaboration', 'owner id', 'undo', 1, false)
write('pr merge', 'repository', 'method body subject match-head-commit', 'merge squash rebase auto')
write('pr update-branch', 'repository')
write('pr revert', 'repository')
write('release create', 'repository', 'body title notes target discussion-category notes-start-tag', 'draft prerelease generate-notes verify-tag notes-from-tag fail-on-no-commits latest')
write('release edit', 'repository', 'body title notes', 'draft prerelease latest')
write('workflow run', 'repository', 'ref field')
write('workflow enable', 'repository')
write('workflow disable', 'repository')
write('run rerun', 'repository', 'job', 'failed debug')
write('run cancel', 'repository')
write('repo create', 'repository', 'description template', 'public private internal', 1, false)
write('repo edit', 'repository', 'description visibility default-branch enable-issues enable-wiki', '', 0)
write('repo fork', 'repository', '', '', 0)
write('gist create', 'repository', 'desc filename', 'public secret', 0, false)
write('gist edit', 'repository', 'desc filename', '', 1, false)
write('gist rename', 'repository', '', '', 3, false)
write('variable set', 'repository', 'body')
write('issue lock', 'repository')
write('issue pin', 'repository')
write('issue transfer', 'repository', 'to-repo')
for (const command of commands.filter(route => ['release create', 'release edit'].includes(route.command))) {
  for (const flag of command.command === 'release edit' ? ['draft', 'prerelease', 'latest'] : ['latest']) command.flags[flag] = 'boolean-value'
}
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
  parserEvidence: 'Hand-reviewed published dispatch switches and per-command parsers; exact writes use host preview and confirmation',
  skillSha256: digest(new URL('skills/gh-axi/SKILL.md', packageRoot)),
  sdk: { ...sdkPin, manifestSha256: digest(new URL('package.json', sdk)) },
  gh: JSON.parse(readFileSync(new URL('gh-source.json', root))),
  sources: [...sources(new URL('dist/', packageRoot), 'dist/'), ...sources(new URL('dist/', sdk), 'axi-sdk-js/dist/')],
  adapterBoundary: { unsafeOverrides: ['hostname', 'watch', 'attach', 'body-file', 'notes-file', 'input', 'file', 'add', 'raw-field', 'header', 'admin', 'delete-branch', 'source', 'push', 'clone', 'remote'],
    blockedCommands: ['home', 'update', 'setup', 'stack', 'pr checkout', 'repo clone', 'gist clone', 'run watch', 'run download', 'release download'],
    nativeWrites: 'host-classified; exact operations, preview and confirmation', inputs: { stdin: 'gist create/edit with filename only', files: 'unsupported' } },
  discovery: { commands: [...new Set(commands.map(route => route.command.split(' ')[0]))],
    example: ['repo', 'list', '--limit', '1'],
    help: 'gh-axi repo list [<owner>] [--limit <n>]\nManaged GitHub API access. Use -R OWNER/NAME for repository commands. Writes require an administrator-enabled exact operation, host preview and --confirm. api accepts [GET] <relative-path>; GraphQL and other methods are refused. Stdin only for gist create/edit with --filename; no files.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
const destination = new URL('inventories/gh-axi.json', root)
const contents = JSON.stringify(data, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: gh-axi; review the pinned commands and effects')
console.log(`inventory: gh-axi ${pkg.version}, ${commands.length} commands`)
