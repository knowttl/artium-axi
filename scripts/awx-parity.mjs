import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { DOMAINS, main } from '../tools/node_modules/@knowttl/awx-axi/dist/cli.js'
import { AUTH_HELP } from '../tools/node_modules/@knowttl/awx-axi/dist/commands/auth.js'
import { SETUP_HELP } from '../tools/node_modules/@knowttl/awx-axi/dist/commands/setup.js'

const root = new URL('../', import.meta.url)
const upstream = new URL('tools/node_modules/@knowttl/awx-axi/', root)
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const pkg = readJson('tools/node_modules/@knowttl/awx-axi/package.json')
if (pkg.version !== readJson('tools/package.json').dependencies['@knowttl/awx-axi']) throw new Error('AWX parity pin mismatch')
const inventory = readJson('tools/inventories/awx-axi.json')
const routes = new Map(inventory.commands.map(route => [route.command, route]))
const securityAdministrationCommands = inventory.commands.filter(route => route.securityAdministration).map(route => route.command)
const securityAdministrationDeletes = securityAdministrationCommands.filter(command => /(?:^|[ -])delete$/.test(command))
const help = async argv => {
  let output = ''
  await main({ argv, env: {}, stdout: { write: chunk => { output += chunk } } })
  return output
}
const topHelp = await help(['--help'])
const updateHelp = await help(['update', '--help'])
const globalNames = [...topHelp.match(/^globals: (.*)$/m)[1].matchAll(/--([a-z-]+)/g)].map(match => match[1])
const recorded = readJson('tools/inventories/awx-axi-parity.json')
const decisions = new Map(recorded.commands.map(route => [route.command, route]))
const localCommands = [
  ...AUTH_HELP.match(/usage: awx-axi auth ([a-z|]+)/)[1].split('|').map(name => `auth ${name}`),
  ...SETUP_HELP.match(/usage: awx-axi setup ([\w|-]+)/)[1].split('|').map(name => `setup ${name}`),
  ...topHelp.match(/^commands: "(.*)"$/m)[1].split(', ').filter(command => !['auth', 'setup'].includes(command)),
  updateHelp.match(/^command: (\w+)$/m)[1],
]
const offered = [...DOMAINS.flatMap(domain => domain.subcommands.map(route => ({ command: `${domain.name} ${route.name}`, flags: route.flags }))),
  ...localCommands.map(command => ({ command, flags: [] }))]
const missingCommands = offered.filter(route => !decisions.has(route.command)).map(route => route.command)
if (missingCommands.length) throw new Error(`Missing AWX support decision: ${missingCommands.join(', ')}; record each decision in tools/inventories/awx-axi-parity.json`)
for (const route of offered.filter(route => localCommands.includes(route.command))) {
  const output = route.command.startsWith('auth ')
    ? AUTH_HELP.split(new RegExp(`\\n  ${route.command.slice(5)}\\s+`))[1]?.split(/\n  [a-z]+\s{2,}/)[0] ?? ''
    : route.command.startsWith('setup ') ? SETUP_HELP : await help([...route.command.split(' '), '--help'])
  route.flags = [...output.matchAll(/--([a-z][a-z0-9-]*)/g)]
    .filter(match => !globalNames.includes(match[1]) && match[1] !== 'help')
    .map(match => ({ name: match[1] }))
}
const complete = decision => decision && typeof decision.name === 'string' && decision.name.trim()
  && typeof decision.status === 'string' && decision.status.trim()
  && (typeof decision.authorization === 'string' && decision.authorization.trim() || typeof decision.reason === 'string' && decision.reason.trim())
const undecided = offered.flatMap(route => {
  const decision = decisions.get(route.command)
  return !decision ? [route.command] : route.flags.filter(flag => !complete(decision.flags.find(reviewed => reviewed.name === flag.name))).map(flag => `${route.command} --${flag.name}`)
})
undecided.push(...globalNames.filter(name => !complete(recorded.globals.find(flag => flag.name === name))).map(name => `global --${name}`))
if (undecided.length) throw new Error(`Missing AWX support decision: ${undecided.join(', ')}; review support in scripts/awx-inventory.mjs and scripts/awx-parity.mjs, then record each decision in tools/inventories/awx-axi-parity.json before regeneration`)
const baseControls = {
  read: 'Managed account access; reads always allowed by write policy',
  write: 'Administrator-controlled per-tenant writes switch, default OFF; preview, explicit confirmation, coordination, audit and unknown-outcome recovery',
  destructive: 'Administrator writes switch plus the separate administrator Allow destructive deletes setting, both default OFF; preview with --dry-run, then explicit --confirm, coordination, audit and unknown-outcome recovery',
}
const previewRequirement = 'each --confirm requires a successful matching --dry-run for the same caller, sign-in family, delegation, tool instance, settings and request; each preview is single-use and lost on server restart'
const targetPolicy = {
  read: baseControls.read,
  write: `${baseControls.write}; security administration also requires Allow security administration, default OFF; for security administration: ${previewRequirement}`,
  destructive: `${baseControls.destructive}; security-administration deletes additionally require Allow security administration, default OFF; for deletes: ${previewRequirement}`,
}
const controlSuffix = (command, authorization) => {
  const security = routes.get(command === 'auth logout' ? 'user token-revoke' : command)?.securityAdministration
  const rawWrite = command.startsWith('api ') && authorization !== 'read'
  const deletion = /(?:^|[ -])delete$/.test(command)
  return (security ? '; Allow security administration, default OFF, also required'
      : rawWrite ? '; Allow security administration, default OFF, also required for /api/v2/ roles, tokens and personal_tokens paths, and organizations, users and teams collections, individual resources and their users, admins, teams, roles, object_roles, access_list, tokens and personal_tokens subresources' : '')
    + (security || deletion ? `; ${previewRequirement}` : rawWrite ? `; for security-administration paths: ${previewRequirement}` : '')
}
const requiredControl = (command, authorization) => baseControls[authorization] + controlSuffix(command, authorization)
const authorizationFor = (command, effect) => ['read', 'client-local'].includes(effect) ? 'read'
  : effect === 'destructive' || command === 'inventory host-bulk-create' ? 'destructive' : 'write'
const configurationControl = 'Administrator allowWrites; AWX_AXI_ALLOW_CONFIG_WRITES derived from that switch; --confirm without --dry-run; AWX resource permission'
const destructiveControl = 'Administrator allowWrites and allowDeletes; AWX_AXI_ALLOW_CONFIG_WRITES and AWX_AXI_ALLOW_DELETES derived from those settings; preview with --dry-run, then --confirm; AWX resource permission'
const sourceFiles = readdirSync(new URL('dist/', upstream), { recursive: true }).filter(path => path.endsWith('.js')).sort()
const sources = sourceFiles.map(path => ({ path: `dist/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/${path}`, upstream))).digest('hex') }))
const security = (domain, name) => ['user', 'team', 'role', 'credential'].includes(domain)
  || /credential|^(?:user|admin|team)-(?:add|remove)$/.test(name)
  || name === 'copy' && ['project', 'execution-environment', 'notification-template'].includes(domain)
const conditionalSecurity = new Set(['inventory source-create', 'inventory source-edit', 'project create', 'project edit', 'execution-environment create', 'execution-environment edit', 'notification-template create', 'notification-template edit'])
// Every upstream flag name needs an explicit reviewed form; an unlisted name fails generation until it is reviewed here.
const flagForms = {
  control: ['help', 'confirm', 'dry-run', 'check'],
  pagination: ['limit', 'all', 'max-rows'],
  output: ['fields', 'tail', 'lines', 'full', 'ansi', 'download'],
  filter: ['status', 'type', 'since', 'host', 'task', 'search', 'failed', 'failed-only', 'include-decided', 'event', 'kind', 'query'],
  wait: ['wait', 'timeout', 'interval'],
  selector: ['template', 'workflow', 'inventory', 'project', 'organization', 'user', 'team', 'credential', 'credential-type', 'execution-environment',
    'instance-group', 'label', 'notification-template', 'child', 'source', 'source-project', 'job', 'workflow-job', 'project-update', 'inventory-update',
    'ad-hoc', 'system-job', 'on', 'to', 'operation', 'default-environment'],
  payload: ['name', 'description', 'playbook', 'scm-type', 'scm-branch', 'job-type', 'verbosity', 'diff', 'tags', 'skip-tags', 'job-tags', 'max-hosts',
    'host-filter', 'update-on-launch', 'no-update-on-launch', 'enabled', 'disabled', 'facts', 'rrule', 'image', 'pull', 'scope', 'username', 'first-name',
    'last-name', 'email', 'is-superuser', 'is-system-auditor', 'no-superuser', 'no-system-auditor', 'notification-type', 'module-name', 'module'],
  structured: inventory.adapterBoundary.structuredInputFlags,
  file: ['inputs-file', 'password-file', 'credential-passwords-file', 'hosts-file', 'configuration-file', 'config-file', 'messages-file', 'body-file'],
  client: ['allow-http'],
}
const formOf = new Map(Object.entries(flagForms).flatMap(([form, names]) => names.map(name => [name, form])))
const unreviewedFlags = [...new Set(DOMAINS.flatMap(domain => domain.subcommands.flatMap(route => route.flags.map(flag => flag.name))))].filter(name => !formOf.has(name))
if (unreviewedFlags.length) throw new Error(`Unreviewed AWX flag forms: ${unreviewedFlags.join(', ')}; classify them in flagForms in scripts/awx-parity.mjs`)
const sensitiveNames = new Set(['inputs-file', 'password-file', 'credential-passwords-file', 'configuration-file', 'config-file', 'messages-file', 'extra-vars', 'variables', 'source-vars', 'module-args', 'args', 'scm-url'])
const inputDetails = (command, name) => {
  const file = name.endsWith('-file') || name === 'extra-vars' || name === 'scm-url'
  const stdin = name === 'password-file' || name === 'inputs-file' && command.startsWith('credential ')
  return {
    secret: sensitiveNames.has(name), file, stdin,
    ...(file || sensitiveNames.has(name) ? { delivery: 'TD-066 file channel: uploaded bytes, bounded private runner leaf, cleanup and redaction; never arbitrary server paths' } : {}),
    ...(name === 'download' ? { outputFile: true, delivery: 'Managed artifact: the value only labels a one-time protected result holding the bounded redacted log; never a caller-selected server path' } : {}),
    ...(name === 'playbook' ? { note: 'AWX project-relative playbook name, not a runner file upload' } : {}),
  }
}
const flagsFor = (command, specs, effect, slice, status) => specs.map(flag => {
  const input = inputDetails(command, flag.name)
  const securityInput = conditionalSecurity.has(command) && ['credential', 'configuration-file', 'config-file', 'messages-file'].includes(flag.name)
  const flagEffect = securityInput ? 'security administration' : effect
  const authorization = ['auth login', 'auth logout'].includes(command) ? 'write' : authorizationFor(command, flagEffect)
  const allowed = routes.get(command)?.flags[flag.name] !== undefined
  const blockedInput = flag.name.endsWith('-file') && !inventory.adapterBoundary.inputFileFlags.includes(flag.name)
  return { ...flag, effect: flagEffect, status: flag.name === 'allow-http' ? 'not applicable' : status === 'supported' && allowed && !blockedInput ? 'supported' : ['managed equivalent', 'not applicable'].includes(status) ? status : 'blocked',
    targetSlice: input.file || input.secret ? 'c' : securityInput ? 'e' : !allowed && status === 'supported' && effect !== 'configuration write' ? 'f' : slice,
    authorization, requiredAdminControl: requiredControl(command, authorization), ...input,
    ...(flagEffect === 'configuration write' && status === 'supported' && allowed && !blockedInput ? { currentAdminControl: (authorization === 'destructive' ? destructiveControl : configurationControl) + controlSuffix(command, authorization) } : {}),
    ...(flag.name === 'allow-http' ? { reason: 'Managed AWX accounts require HTTPS; no HTTP opt-in equivalent' } : {}),
    ...(status === 'supported' && !allowed ? { reason: 'Omitted from the reviewed Artium flag schema' } : {}),
    ...(blockedInput ? { reason: 'Not yet supported: requires secure input' } : {}) }
})
const commands = DOMAINS.flatMap(domain => domain.subcommands.map(route => {
  const command = `${domain.name} ${route.name}`
  const current = routes.get(command)
  if (!current) throw new Error(`Missing reviewed AWX route: ${command}`)
  const mutation = route.flags.some(flag => flag.name === 'confirm')
  const effect = !mutation ? 'read' : /(?:^|-)delete$/.test(route.name) ? 'destructive'
    : current.effect === 'write' ? 'operational write' : security(domain.name, route.name) ? 'security administration' : 'configuration write'
  const targetSlice = effect === 'read' || effect === 'operational write' ? 'f'
    : effect === 'destructive' || route.name.includes('bulk') ? 'd'
    : effect === 'security administration' ? domain.name === 'credential' || route.name === 'credential-create' ? 'c' : 'e' : 'b'
  const status = ['blocked', 'secure-input'].includes(current.effect) ? 'blocked' : 'supported'
  const authorization = authorizationFor(command, effect)
  return { command, effect, status, targetSlice, authorization, requiredAdminControl: requiredControl(command, authorization), positionals: route.positionals, help: route.help,
    ...(current.effect === 'secure-input' ? { reason: 'Not yet supported: requires secure input' } : {}),
    ...(effect === 'configuration write' && status === 'supported' ? { currentAdminControl: (authorization === 'destructive' ? destructiveControl : configurationControl) + controlSuffix(command, authorization) } : {}),
    ...(conditionalSecurity.has(command) ? { conditionalEffect: 'Upstream security administration effect when credential or notification configuration/messages input is supplied; this input alone does not require Allow security administration',
      dependentSlices: ['c', 'e'] } : {}),
    ...(effect === 'destructive' && security(domain.name, route.name) ? { note: 'Upstream delete tag checks only the native delete gate; Artium supplies that gate only under the separate Allow destructive deletes setting' } : {}),
    ...(command === 'user token-revoke' ? { note: 'Upstream DELETE tagged security, so the native security gate applies rather than the delete gate; target authorization is write', dependentSlices: ['d'] } : {}),
    ...(command === 'user token-create' ? { note: 'Confirmed creation delivers the PAT through an authenticated one-time protected result, scoped to the caller and current managed credential revision, expiring after five minutes; no token bytes in routine output or audit' } : {}),
    ...(command === 'inventory host-bulk-delete' ? { note: 'The pinned CLI reports any 2xx as deleted; Artium returns PARTIAL_OUTCOME with unconfirmed_hosts unless the controller confirms every requested host' } : {}),
    ...(command === 'job watch' || route.flags.some(flag => flag.name === 'wait') ? { note: `Artium runner has a bounded lifetime: waits last at most ${inventory.adapterBoundary.waitTimeoutSeconds} seconds, the default; larger --timeout values are refused and ${command === 'job watch' ? 'job watch resumes' : 'job watch resumes the wait'}` } : {}),
    flags: flagsFor(command, [{ name: 'help', takesValue: false, description: 'Command help' }, ...route.flags], effect, targetSlice, status) }
}))

const localReasons = {
  'auth login': ['managed equivalent', 'Artium AWX account form accepts a PAT or exchanges username/password for a PAT; raw upstream login is blocked. Passwords and tokens use the managed credential store, never argv.'],
  'auth logout': ['managed equivalent', 'Managed accounts do not retain a verified current PAT id. Use user token-revoke <numeric-token-id> under the administrator-controlled per-tenant writes switch and Allow security administration, both default OFF, with preview, explicit confirmation and audit. The managed account is preserved; account removal does not revoke its upstream PAT.'],
  'config path': ['not applicable', 'Artium materializes private runner configuration. There is no client-owned upstream config path to expose.'],
  'profile list': ['managed equivalent', 'Use Artium account discovery and selection; upstream filesystem profiles are not caller-owned.'],
  'setup hooks': ['managed equivalent', 'Use artium-axi setup --host <claude|codex|opencode> --hook on Linux for authenticated ambient tool context and granted tool skills. Claude Code and Codex use SessionStart; OpenCode 1.19.x uses its local system-context plugin API. Codex host trust and feature controls still apply. Pi and non-Linux hosts retain skill-only setup. Never install hooks in the server runner.'],
  update: ['not applicable', 'The deployment pins awx-axi through tools/package.json and integrity.json. Upgrade through a reviewed Artium dependency change; per-run self-update is blocked.'],
}
for (const command of ['home', ...localCommands]) {
  const remoteRead = ['home', 'doctor', 'auth status'].includes(command)
  const [status, reason] = remoteRead ? ['supported', 'Uses the selected managed AWX account; upstream identity/read diagnostics retained'] : localReasons[command]
  const effect = remoteRead ? 'read' : 'client-local'
  const specs = [{ name: 'help', takesValue: false, description: 'Command help' }]
  if (command === 'auth login') specs.push(...[...AUTH_HELP.matchAll(/--(allow-http)\b/g)].slice(0, 1).map(match => ({ name: match[1], takesValue: false, description: 'Opt into unencrypted HTTP; unavailable in Artium HTTPS accounts' })))
  if (command === 'update') specs.push(...[...updateHelp.matchAll(/^  "--([a-z-]+)": (.*)$/gm)].map(match => ({ name: match[1], takesValue: false, description: match[2] })))
  const authorization = ['auth login', 'auth logout'].includes(command) ? 'write' : 'read'
  commands.push({ command, effect, status, reason, targetSlice: command === 'auth logout' ? 'e' : 'f', authorization, requiredAdminControl: requiredControl(command, authorization),
    flags: [...flagsFor(command, specs, effect, 'f', status), ...offered.find(route => route.command === command)?.flags
      .filter(flag => !specs.some(spec => spec.name === flag.name)).map(flag => decisions.get(command).flags.find(reviewed => reviewed.name === flag.name)) ?? []],
    ...(command.startsWith('auth ') && command !== 'auth status' ? { remoteEffect: 'security administration', note: 'Client-local lifecycle also mints or revokes an upstream PAT; upstream logout uses the native security-tagged DELETE gate' } : {}) })
}

// The pinned inventory router accepts these alternate spellings without separate leaf metadata.
const aliases = commands.filter(route => /^inventory (host|group|source)-/.test(route.command)).flatMap(route => {
  const suffix = route.command.slice('inventory '.length)
  const [noun, ...parts] = suffix.split('-')
  const spellings = [`inventory ${noun} ${parts.join('-')}`]
  if (noun !== 'host' && parts.length > 1) spellings.push(`inventory ${noun} ${parts.join(' ')}`)
  return spellings.map(command => ({ command, canonicalCommand: route.command, effect: route.effect, status: 'managed equivalent', targetSlice: route.targetSlice,
    authorization: route.authorization, requiredAdminControl: route.requiredAdminControl, reason: `Artium rejects the upstream nested spelling with the canonical command list; ${route.command} is the managed equivalent with identical flags, effect and authorization`,
    ...(noun !== 'host' && parts.length > 1 ? { upstreamException: 'Pinned router joins every trailing token into the action for non-CRUD group/source aliases, including flags and values. Use canonical spelling for working invocations.' } : {}),
    flags: route.flags }))
})
// Reviewed decisions: changing the upstream surface must change these numbers and digest in the same diff as its classification.
const reviewedSurface = { commands: 220, aliases: 27, flagOccurrences: 1070, routerSha256: 'e08ea3de7f2232b47e603772ca5baf86bc2907823d3e49dcedf7eb2d574f4393', surfaceSha256: '8af8358bb8158816fc1be036dd556b9669a174c1741c2429ddc70281a442fff8' }
const surfaceLines = [...DOMAINS.flatMap(domain => domain.subcommands.flatMap(route => [`${domain.name} ${route.name} ${JSON.stringify(route.positionals)}`,
  ...route.flags.map(flag => `${domain.name} ${route.name} --${flag.name} ${flag.takesValue}`)])), ...aliases.map(alias => `${alias.command} => ${alias.canonicalCommand}`)].sort()
const measuredSurface = { commands: commands.length, aliases: aliases.length, flagOccurrences: commands.reduce((count, route) => count + route.flags.length, 0),
  routerSha256: createHash('sha256').update(String(DOMAINS.find(domain => domain.name === 'inventory').run)).digest('hex'),
  surfaceSha256: createHash('sha256').update(surfaceLines.join('\n')).digest('hex') }
if (JSON.stringify(measuredSurface) !== JSON.stringify(reviewedSurface)) throw new Error(`Unreviewed AWX surface change: ${JSON.stringify(measuredSurface)}; review new commands, flags, aliases, input forms and conditional effects, then update reviewedSurface in scripts/awx-parity.mjs`)
const credentialInputs = new Set(['credential', 'configuration-file', 'config-file', 'messages-file', 'inputs-file', 'password-file', 'credential-passwords-file'])
const reviewedOperationalCredentialUse = new Set(['job launch', 'template launch', 'ad-hoc launch'])
const unreviewedConditional = commands.filter(route => route.effect !== 'read' && route.effect !== 'client-local' && route.flags.some(flag => credentialInputs.has(flag.name))
  && route.effect !== 'security administration' && !route.conditionalEffect && !reviewedOperationalCredentialUse.has(route.command)).map(route => route.command)
if (unreviewedConditional.length) throw new Error(`Unreviewed conditional security effect: ${unreviewedConditional.join(', ')}`)
const globals = globalNames.map(name => !['config', 'profile', 'origin', 'verify-ssl'].includes(name) ? recorded.globals.find(flag => flag.name === name) : ({ name, takesValue: true, effect: 'client-local', status: 'managed equivalent', targetSlice: 'f',
  authorization: 'read', requiredAdminControl: targetPolicy.read, reason: name === 'config' ? 'Server materializes private config; upstream file path override blocked'
    : name === 'profile' ? 'Select an Artium managed account; upstream profile override blocked'
    : name === 'origin' ? 'Administrator configures HTTPS origin on the managed account; runner override blocked'
    : 'Managed certificate trust and HTTPS policy; raw TLS verification override blocked',
  file: name === 'config', secret: false, ...(name === 'config' ? { delivery: 'Managed runner config, not a TD-066 user input; arbitrary server paths forbidden' } : {}) }))
const versionFlags = ['--version', '-v', '-V'].map(name => ({ name, effect: 'client-local', status: 'supported', targetSlice: 'f', authorization: 'read', requiredAdminControl: targetPolicy.read, scope: 'Bare invocation only' }))
const classification = ({ flags, help, positionals, description, takesValue, ...decision }) => decision
const conflicts = []
for (const [entries, previous, key] of [[commands, recorded.commands, 'command'], [aliases, recorded.aliases, 'command'],
  [globals, recorded.globals, 'name'], [versionFlags, recorded.versionFlags, 'name']]) {
  for (const entry of entries) {
    const prior = previous.find(item => item[key] === entry[key])
    if (!prior) continue
    if (!isDeepStrictEqual(classification(entry), classification(prior))) conflicts.push(entry[key])
    for (const flag of entry.flags ?? []) {
      const priorFlag = prior.flags.find(item => item.name === flag.name)
      if (priorFlag && !isDeepStrictEqual(classification(flag), classification(priorFlag))) conflicts.push(`${entry[key]} --${flag.name}`)
    }
  }
}
if (conflicts.length) throw new Error(`AWX support decisions differ from generated classifications: ${conflicts.join(', ')}; reconcile the recorded decisions and generator before regeneration`)
const data = { generatedBy: 'scripts/awx-parity.mjs', tool: pkg.name, version: pkg.version,
  extraction: 'Offline DOMAINS subcommands/flags/positionals/help; main --help and update --help; AUTH_HELP and SETUP_HELP; reviewed inventory router aliases and transport tags',
  sources, globalFlagScope: 'Four selection overrides accepted upstream before/after commands; inherited by every leaf. --help is universal. Version flags are bare only.',
  targetPolicy, globals, versionFlags, commands, aliases }
const rows = entries => entries.map(entry => `| ${entry.command ?? `--${entry.name}`} | ${entry.effect} | ${entry.status} | ${entry.targetSlice} | ${entry.authorization} |`).join('\n')
const table = entries => '| Command or flag | Upstream effect | Artium status | Slice | Target authorization |\n| --- | --- | --- | --- | --- |\n' + rows(entries)
const matrix = `# Generated AWX parity matrix\n\nGenerated by scripts/awx-parity.mjs from installed awx-axi ${pkg.version}.\nSee [scope, controls and delivery plan](awx-parity.md) and [machine-readable matrix](../tools/inventories/awx-axi-parity.json).\nDo not edit this generated file.\n\n## Target authorization policy\n\nThis is the target policy, not the [current implemented write boundary](safety.md#write-gates-by-tool).\n\n- read: ${targetPolicy.read}.\n- write: ${targetPolicy.write}.\n- destructive: ${targetPolicy.destructive}.\n\nDeletes and bulk host create/delete need the separate Allow destructive deletes setting in addition to the writes switch.\nSecurity administration needs the separate Allow security administration setting in addition to the writes switch, default OFF, with preview by --dry-run and explicit --confirm. It covers the commands tagged securityAdministration in tools/inventories/awx-axi.json: ${securityAdministrationCommands.join(', ')}.\nSecurity-administration deletes (${securityAdministrationDeletes.join(', ')}) need both Allow security administration and Allow destructive deletes.\nRaw api writes to security-administration paths also need Allow security administration; see [Raw API access](safety.md#raw-api-access).\nFor security administration and deletes, ${previewRequirement}.\nOrdinary configuration associations, such as template credential-add and organization notification-add, need the writes switch alone.\nThe Effect column reports upstream effect labels and does not select this gate; among named commands, only those listed above require Allow security administration; raw API writes are subject to the path-based rule above.\nUpstream config/delete/security tags and native gates remain implementation constraints, not administrator permission tiers.\nArtium must supply the appropriate native gates under the writes switch and, for destructive operations, the Allow destructive deletes setting.\nAll operations retain tenant/account access, managed HTTPS origin, verified TLS, credential isolation and AWX resource authorization.\nClient-local managed equivalents never permit caller-controlled runner configuration.\nHelp itself is read-only; a mutation row's authorization governs preview/execution, not help.\n\n## Global flags\n\n${table(globals)}\n\n${table(versionFlags.map(flag => ({ ...flag, command: flag.name })))}\n\n## Commands\n\n${table(commands)}\n\n## Upstream nested aliases\n\n${table(aliases)}\n\n## Flags by command\n\nEvery row inherits its command's reasons and restrictions from the JSON; conditional upstream effects do not add target permission tiers.\nGlobal selection flags above apply to every command; per-command --help is included below.\nSecret/file inputs use the TD-066 private file channel. Structured flags accept inline values or @local-file; credential inputs-file and password-file also accept stdin (-).\n\n${commands.map(command => `### ${command.command}\n\n${command.reason ?? command.note ?? 'See command controls above.'}\n\n| Flag | Value | Status | Slice | Target authorization | Secret / file / stdin |\n| --- | --- | --- | --- | --- | --- |\n${command.flags.map(flag => `| --${flag.name} | ${flag.takesValue ? 'value' : 'boolean'} | ${flag.status} | ${flag.targetSlice} | ${flag.authorization} | ${[flag.secret && 'potential secret', flag.file && 'file', flag.stdin && 'stdin', flag.outputFile && 'output file'].filter(Boolean).join(', ') || 'none'} |`).join('\n')}\n`).join('\n')}\n`
for (const [path, contents] of [['tools/inventories/awx-axi-parity.json', JSON.stringify(data, null, 2) + '\n'], ['docs/awx-parity-matrix.md', matrix]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) writeFileSync(destination, contents)
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error(`AWX parity matrix stale: ${path}; run node scripts/awx-parity.mjs --write and review classifications`)
}
console.log(`parity: awx-axi ${pkg.version}, ${commands.length} commands, ${aliases.length} aliases, ${commands.reduce((count, route) => count + route.flags.length, 0)} command flags, ${globals.length} selection globals, ${versionFlags.length} version flags`)
