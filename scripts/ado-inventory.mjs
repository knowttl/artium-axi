import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/ado-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for ado-axi')
// Reviewed against 0.5.0 dispatch switches and *_FLAGS constants. Query POSTs
// (WIQL and workitemsbatch) are reads. Re-pinning requires reviewing effects too.
const globals = { profile: 'value', org: 'value', project: 'value', config: 'value', help: 'boolean', full: 'boolean', fields: 'value' }
const commands = []
function route(command, effect, values = '', booleans = '', positionals = 0, aliases = []) {
  commands.push({ command, effect, flags: { ...globals,
    ...Object.fromEntries(values.split(' ').filter(Boolean).map(name => [name, 'value'])),
    ...Object.fromEntries(booleans.split(' ').filter(Boolean).map(name => [name, 'boolean'])) }, positionals, aliases })
}
route('home', 'read')
route('doctor', 'read')
route('work-item list', 'read', 'state type assigned-to iteration area tag search query limit')
route('work-item get', 'read', '', 'comments relations', 1, ['work-item view'])
route('work-item create', 'write', 'type title description description-format assigned-to area iteration parent tags set')
route('work-item update', 'write', 'title state assigned-to area iteration description description-format tags add-tags remove-tags set reason if-rev', '', 1)
route('work-item delete', 'write', 'if-rev', 'destroy confirm-destroy', 1)
route('work-item attach', 'blocked', 'file comment if-rev', '', 1)
route('work-item attachment get', 'blocked', 'name out', 'force', 1)
route('work-item comment', 'write', 'body format', '', 2)
route('work-item link list', 'read', 'limit', '', 1, ['work-item links list'])
route('work-item link add', 'write', 'parent child related pr commit branch repo comment if-rev', '', 1, ['work-item links add'])
route('work-item link remove', 'write', 'index if-rev', '', 1, ['work-item links remove'])
route('work-item link types', 'read', 'limit', '', 0, ['work-item links types'])
route('query run', 'read', 'limit', '', 1)
route('area list', 'read', 'limit depth')
route('iteration list', 'read', 'limit depth')
route('pr list', 'read', 'repo status creator reviewer target source limit')
route('pr get', 'read', 'repo id', 'threads commits', 1, ['pr view', 'pr comments', 'pr threads'])
route('pr create', 'write', 'repo source target title description reviewers work-items', 'draft auto-complete')
route('pr update', 'write', 'repo title description', 'draft auto-complete', 1)
route('pr complete', 'write', 'repo', 'squash delete-source-branch', 1)
route('pr abandon', 'write', 'repo', '', 1)
route('pr checks', 'read', 'repo limit', '', 1)
route('pr diff', 'read', 'repo limit', '', 1, ['pr changes'])
route('pr reviewers', 'read', 'repo reviewer', 'required', 1)
route('pr reviewer list', 'read', 'repo reviewer', 'required', 1)
route('pr reviewer add', 'write', 'repo reviewer', 'required', 1)
route('pr reviewer remove', 'write', 'repo reviewer', 'required', 1)
route('pr approve', 'write', 'repo vote', '', 1, ['pr vote'])
route('pr comment', 'write', 'repo body thread file line', '', 2)
route('pr thread list', 'read', 'repo limit id', '', 1)
route('pr thread resolve', 'write', 'repo thread status id', '', 2)
route('pr thread reopen', 'write', 'repo thread status id', '', 2)
route('pr thread reply', 'write', 'repo thread body status id', 'resolve', 3)
route('pipeline list', 'read', 'limit name')
route('pipeline runs', 'read', 'pipeline branch status result requested-for limit')
route('pipeline run', 'write', 'pipeline branch variables parameters', '', 1)
route('pipeline show', 'read', 'id pipeline limit', '', 1)
route('pipeline variable list', 'read', 'id pipeline limit', '', 1)
route('pipeline create', 'write', 'definition')
route('pipeline update', 'write', 'definition if-rev', '', 1)
route('pipeline delete', 'write', 'if-rev', 'confirm-delete', 1)
route('pipeline build cancel', 'write', '', '', 1)
for (const action of ['add', 'remove']) {
  route(`pipeline build tag ${action}`, 'write', 'tag', '', 1, [`pipeline runs tag ${action}`])
}
route('pipeline folder list', 'read', 'path limit')
route('pipeline folder create', 'write', 'path')
route('pipeline folder delete', 'write', 'path', 'confirm-delete')
route('pipeline release list', 'read', 'definition limit')
route('pipeline release show', 'read', 'limit', '', 1)
route('pipeline release create', 'write', 'definition description artifacts', 'draft')
route('pipeline runs artifact list', 'read', 'limit', '', 1)
route('pipeline runs artifact download', 'blocked', 'name out', 'force', 1)
route('pipeline logs', 'read', 'log tail', 'failed-only', 1)
route('pipeline timeline', 'read', 'limit', '', 1, ['pipeline steps'])
route('pipeline watch', 'read', 'interval timeout', '', 1)
route('test results', 'read', 'run outcome limit', '', 1, ['test failures'])
route('repo list', 'read', 'name limit')
route('repo show', 'read', 'id repo limit', '', 1)
route('repo create', 'write', 'name')
route('repo update', 'write', 'repo name default-branch disabled')
route('repo delete', 'write', 'repo', 'confirm-delete')
route('repo import', 'write', 'repo source-url service-endpoint')
route('repo policy list', 'read', 'repo branch limit')
route('repo policy show', 'read', 'id limit', '', 1)
route('repo policy create', 'write', 'policy-json')
route('repo policy update', 'write', 'policy-json if-rev', '', 1)
route('repo policy delete', 'write', 'if-rev', 'confirm-delete', 1)
route('repo branches', 'read', 'repo limit name', '', 1)
route('repo file', 'read', 'repo path ref commit limit', '', 2, ['repo cat'])
route('ref list', 'read', 'repo name limit')
route('ref create', 'write', 'repo name source source-object-id')
route('ref delete', 'write', 'repo name old-object-id')
route('project list', 'read', 'limit name')
route('project show', 'read', 'id limit', '', 1)
for (const group of ['service-endpoint', 'variable-group', 'agent', 'pool', 'queue', 'user']) {
  for (const action of ['list', 'show']) {
    route(`${group} ${action}`, 'read', `${group === 'agent' ? 'pool ' : ''}limit${action === 'show' ? ' id' : ''}`,
      '', action === 'show' ? 1 : 0, ['variable-group', 'agent', 'pool', 'queue'].includes(group) ? [`pipeline ${group} ${action}`] : [])
  }
}
route('team list', 'read', 'limit')
route('team member list', 'read', 'team limit', '', 0, ['team list-member'])
route('security group list', 'read', 'scope limit')
route('security group show', 'read', 'id limit', '', 1)
route('security membership list', 'read', 'id direction limit', '', 1, ['security group membership list'])
route('security permission list', 'read', 'namespace token subject limit')
route('security permission show', 'read', 'namespace token subject limit')
route('api', 'read', 'method body query api-version host limit content-type', 'no-project raw', 2)
route('config', 'blocked')
for (const sub of ['list', 'show', 'path', 'init', 'add']) route(`config ${sub}`, 'blocked')
route('update', 'blocked')
const sourcePaths = ['dist/bin/ado-axi.js', ...['auth', 'client', 'args', 'argv', 'config', 'adoUrl', 'stdin', 'context', 'writes', 'audit'].map(name => `dist/lib/${name}.js`),
  ...readdirSync(new URL('dist/commands/', packageRoot)).filter(name => name.endsWith('.js')).sort().map(name => `dist/commands/${name}`)]
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sdk = new URL('../../axi-sdk-js/dist/cli.js', pathToFileURL(realpathSync(packageRoot) + '/'))
const data = { generatedBy: 'scripts/ado-inventory.mjs', tool: 'ado-axi', ...pin,
  skillSha256: digest(new URL('SKILL.md', packageRoot)),
  parserEvidence: 'Reviewed published dispatch switches, aliases and command flag constants',
  sources: [...sourcePaths.map(path => ({ path, sha256: digest(new URL(path, packageRoot)) })),
    { path: 'axi-sdk-js/dist/cli.js', sha256: digest(sdk) }],
  adapterBoundary: { unsafeOverrides: ['org', 'profile', 'config'], blockedCommands: commands.filter(route => route.effect === 'blocked').map(route => route.command),
    nativeWrites: 'host-classified', inputs: { stdin: 'unsupported', files: 'unsupported' } },
  aliases: { wi: 'work-item', workitem: 'work-item', 'work-items': 'work-item', prs: 'pr', pipelines: 'pipeline',
    tests: 'test', repos: 'repo', refs: 'ref', projects: 'project' },
  discovery: { commands: ['work-item', 'query', 'area', 'iteration', 'pr', 'pipeline', 'test', 'repo', 'ref', 'project',
    'security', 'service-endpoint', 'variable-group', 'agent', 'pool', 'queue', 'user', 'team', 'api', 'doctor'],
    example: ['project', 'list', '--limit', '1'],
    help: 'ado-axi project list [--name <filter>] [--limit <n>] [--fields <fields>]\napi defaults to GET; -X/--method POST|PATCH|PUT|DELETE requires allowWrites, a server-listed relative path and bounded JSON --body. Decisions are journaled (TD-067). No stdin or files. For pipeline watch use --timeout 50 or less.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
const destination = new URL('inventories/ado-axi.json', root)
const contents = JSON.stringify(data, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: ado-axi; review the pinned commands and effects')
console.log(`inventory: ado-axi ${pkg.version}, ${commands.length} commands`)
