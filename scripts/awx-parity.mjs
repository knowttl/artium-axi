import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DOMAINS, main } from '../tools/node_modules/awx-axi/dist/cli.js'
import { AUTH_HELP } from '../tools/node_modules/awx-axi/dist/commands/auth.js'
import { SETUP_HELP } from '../tools/node_modules/awx-axi/dist/commands/setup.js'

const root = new URL('../', import.meta.url)
const upstream = new URL('tools/node_modules/awx-axi/', root)
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const pkg = readJson('tools/node_modules/awx-axi/package.json')
if (pkg.version !== readJson('tools/package.json').dependencies['awx-axi']) throw new Error('AWX parity pin mismatch')
const inventory = readJson('tools/inventories/awx-axi.json')
const routes = new Map(inventory.commands.map(route => [route.command, route]))
const help = async argv => {
  let output = ''
  await main({ argv, env: {}, stdout: { write: chunk => { output += chunk } } })
  return output
}
const topHelp = await help(['--help'])
const updateHelp = await help(['update', '--help'])
const globalNames = [...topHelp.match(/^globals: (.*)$/m)[1].matchAll(/--([a-z-]+)/g)].map(match => match[1])
const targetPolicy = {
  read: 'Managed account access; reads always allowed by write policy',
  write: 'One administrator-controlled per-tenant writes switch, default OFF; all writes including destructive and security administration require it; preview, explicit confirmation, coordination, audit and unknown-outcome recovery',
}
const authorizationFor = effect => ['read', 'client-local'].includes(effect) ? 'read' : 'write'
const configurationControl = 'Administrator allowWrites; AWX_AXI_ALLOW_CONFIG_WRITES derived from that switch; --confirm without --dry-run; AWX resource permission'
const sourceFiles = readdirSync(new URL('dist/', upstream), { recursive: true }).filter(path => path.endsWith('.js')).sort()
const sources = sourceFiles.map(path => ({ path: `dist/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/${path}`, upstream))).digest('hex') }))
const security = (domain, name) => ['user', 'team', 'role', 'credential'].includes(domain)
  || /credential|^(?:user|admin|team)-(?:add|remove)$/.test(name)
  || name === 'copy' && ['project', 'execution-environment', 'notification-template'].includes(domain)
const conditionalSecurity = new Set(['inventory source-create', 'inventory source-edit', 'project create', 'project edit', 'execution-environment create', 'execution-environment edit', 'notification-template create', 'notification-template edit'])
const sensitiveNames = new Set(['inputs-file', 'password-file', 'credential-passwords-file', 'configuration-file', 'config-file', 'messages-file', 'extra-vars', 'variables', 'source-vars', 'module-args', 'args', 'scm-url'])
const inputDetails = (command, name) => {
  const file = name.endsWith('-file') || name === 'extra-vars' || name === 'scm-url'
  const stdin = name === 'password-file' || name === 'inputs-file' && command.startsWith('credential ')
  return {
    secret: sensitiveNames.has(name), file, stdin,
    ...(file || sensitiveNames.has(name) ? { delivery: 'TD-066 file channel: uploaded bytes, bounded private runner leaf, cleanup and redaction; never arbitrary server paths' } : {}),
    ...(name === 'download' ? { outputFile: true, delivery: 'Managed artifact download required; never a caller-selected server path' } : {}),
    ...(name === 'playbook' ? { note: 'AWX project-relative playbook name, not a runner file upload' } : {}),
  }
}
const flagsFor = (command, specs, effect, slice, status) => specs.map(flag => {
  const input = inputDetails(command, flag.name)
  const securityInput = conditionalSecurity.has(command) && ['credential', 'configuration-file', 'config-file', 'messages-file'].includes(flag.name)
  const flagEffect = securityInput ? 'security administration' : effect
  const authorization = ['auth login', 'auth logout'].includes(command) ? 'write' : authorizationFor(flagEffect)
  const allowed = routes.get(command)?.flags[flag.name] !== undefined
  const blockedInput = flag.name.endsWith('-file') && !inventory.adapterBoundary.inputFileFlags.includes(flag.name)
  return { ...flag, effect: flagEffect, status: flag.name === 'allow-http' ? 'not applicable' : status === 'supported' && allowed && !blockedInput ? 'supported' : status === 'managed equivalent' ? status : 'blocked',
    targetSlice: input.file || input.secret ? 'c' : securityInput ? 'e' : !allowed && status === 'supported' && effect !== 'configuration write' ? 'f' : slice,
    authorization, requiredAdminControl: targetPolicy[authorization], ...input,
    ...(flagEffect === 'configuration write' && status === 'supported' && allowed && !blockedInput ? { currentAdminControl: configurationControl } : {}),
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
  const authorization = authorizationFor(effect)
  return { command, effect, status, targetSlice, authorization, requiredAdminControl: targetPolicy[authorization], positionals: route.positionals, help: route.help,
    ...(current.effect === 'secure-input' ? { reason: 'Not yet supported: requires secure input' } : {}),
    ...(effect === 'configuration write' && status === 'supported' ? { currentAdminControl: configurationControl } : {}),
    ...(conditionalSecurity.has(command) ? { conditionalEffect: 'security administration when credential or notification configuration/messages input is supplied',
      dependentSlices: ['c', 'e'] } : {}),
    ...(effect === 'destructive' && security(domain.name, route.name) ? { note: 'Upstream delete tag checks only the native delete gate; this is not a separate target permission' } : {}),
    ...(command === 'user token-revoke' ? { note: 'Upstream DELETE tagged security, so the native security gate applies rather than the delete gate; target authorization is write', dependentSlices: ['d'] } : {}),
    ...(command === 'job watch' ? { note: 'Artium runner has a bounded lifetime; use --timeout 50 or less' } : {}),
    flags: flagsFor(command, [{ name: 'help', takesValue: false, description: 'Command help' }, ...route.flags], effect, targetSlice, status) }
}))

const localReasons = {
  'auth login': ['managed equivalent', 'Artium AWX account form accepts a PAT or exchanges username/password for a PAT; raw upstream login is blocked. Passwords and tokens use the managed credential store, never argv.'],
  'auth logout': ['blocked', 'Raw managed auth logout remains refused; removing a managed account does not revoke its upstream PAT. Use user token-revoke under the single administrator-controlled per-tenant writes switch, default OFF, with preview, explicit confirmation and audit.'],
  'config path': ['not applicable', 'Artium materializes private runner configuration. There is no client-owned upstream config path to expose.'],
  'profile list': ['managed equivalent', 'Use Artium account discovery and selection; upstream filesystem profiles are not caller-owned.'],
  'setup hooks': ['managed equivalent', 'Use artium-axi setup --host <claude|codex|opencode> --hook on Linux for authenticated ambient tool context and granted tool skills. Claude Code and Codex use SessionStart; OpenCode 1.19.x uses its local system-context plugin API. Codex host trust and feature controls still apply. Pi and non-Linux hosts retain skill-only setup. Never install hooks in the server runner.'],
  update: ['not applicable', 'The deployment pins awx-axi through tools/package.json and integrity.json. Upgrade through a reviewed Artium dependency change; per-run self-update is blocked.'],
}
const localCommands = [
  ...AUTH_HELP.match(/usage: awx-axi auth ([a-z|]+)/)[1].split('|').map(name => `auth ${name}`),
  SETUP_HELP.match(/usage: awx-axi (setup \w+)/)[1],
  ...topHelp.match(/^commands: "(.*)"$/m)[1].split(', ').filter(name => name.includes(' ') || name === 'doctor'),
  updateHelp.match(/^command: (\w+)$/m)[1],
]
for (const command of ['home', ...localCommands]) {
  const remoteRead = ['home', 'doctor', 'auth status'].includes(command)
  const [status, reason] = remoteRead ? ['supported', 'Uses the selected managed AWX account; upstream identity/read diagnostics retained'] : localReasons[command]
  const effect = remoteRead ? 'read' : 'client-local'
  const specs = [{ name: 'help', takesValue: false, description: 'Command help' }]
  if (command === 'auth login') specs.push(...[...AUTH_HELP.matchAll(/--(allow-http)\b/g)].slice(0, 1).map(match => ({ name: match[1], takesValue: false, description: 'Opt into unencrypted HTTP; unavailable in Artium HTTPS accounts' })))
  if (command === 'update') specs.push(...[...updateHelp.matchAll(/^  "--([a-z-]+)": (.*)$/gm)].map(match => ({ name: match[1], takesValue: false, description: match[2] })))
  const authorization = ['auth login', 'auth logout'].includes(command) ? 'write' : 'read'
  commands.push({ command, effect, status, reason, targetSlice: command === 'auth logout' ? 'e' : 'f', authorization, requiredAdminControl: targetPolicy[authorization],
    flags: flagsFor(command, specs, effect, 'f', status),
    ...(command.startsWith('auth ') && command !== 'auth status' ? { remoteEffect: 'security administration', note: 'Client-local lifecycle also mints or revokes an upstream PAT; upstream logout uses the native security-tagged DELETE gate' } : {}) })
}

// The pinned inventory router accepts these alternate spellings without separate leaf metadata.
const aliases = commands.filter(route => /^inventory (host|group|source)-/.test(route.command)).flatMap(route => {
  const suffix = route.command.slice('inventory '.length)
  const [noun, ...parts] = suffix.split('-')
  const spellings = [`inventory ${noun} ${parts.join('-')}`]
  if (noun !== 'host' && parts.length > 1) spellings.push(`inventory ${noun} ${parts.join(' ')}`)
  return spellings.map(command => ({ command, canonicalCommand: route.command, effect: route.effect, status: 'blocked', targetSlice: route.targetSlice,
    authorization: route.authorization, requiredAdminControl: route.requiredAdminControl, reason: 'Upstream nested alias; Artium accepts only canonical inventory leaf spelling',
    ...(noun !== 'host' && parts.length > 1 ? { upstreamException: 'Pinned router joins every trailing token into the action for non-CRUD group/source aliases, including flags and values. Use canonical spelling for working invocations; slice f must track this upstream limitation.' } : {}),
    flags: route.flags.map(flag => ({ ...flag, status: 'blocked' })) }))
})
const globals = globalNames.map(name => ({ name, takesValue: true, effect: 'client-local', status: 'managed equivalent', targetSlice: 'f',
  authorization: 'read', requiredAdminControl: targetPolicy.read, reason: name === 'config' ? 'Server materializes private config; upstream file path override blocked'
    : name === 'profile' ? 'Select an Artium managed account; upstream profile override blocked'
    : name === 'origin' ? 'Administrator configures HTTPS origin on the managed account; runner override blocked'
    : 'Managed certificate trust and HTTPS policy; raw TLS verification override blocked',
  file: name === 'config', secret: false, ...(name === 'config' ? { delivery: 'Managed runner config, not a TD-066 user input; arbitrary server paths forbidden' } : {}) }))
const versionFlags = ['--version', '-v', '-V'].map(name => ({ name, effect: 'client-local', status: 'supported', targetSlice: 'f', authorization: 'read', requiredAdminControl: targetPolicy.read, scope: 'Bare invocation only' }))
const data = { generatedBy: 'scripts/awx-parity.mjs', tool: pkg.name, version: pkg.version,
  extraction: 'Offline DOMAINS subcommands/flags/positionals/help; main --help and update --help; AUTH_HELP and SETUP_HELP; reviewed inventory router aliases and transport tags',
  sources, globalFlagScope: 'Four selection overrides accepted upstream before/after commands; inherited by every leaf. --help is universal. Version flags are bare only.',
  targetPolicy, globals, versionFlags, commands, aliases }
const rows = entries => entries.map(entry => `| ${entry.command ?? `--${entry.name}`} | ${entry.effect} | ${entry.status} | ${entry.targetSlice} | ${entry.authorization} |`).join('\n')
const table = entries => '| Command or flag | Upstream effect | Artium status | Slice | Target authorization |\n| --- | --- | --- | --- | --- |\n' + rows(entries)
const matrix = `# Generated AWX parity matrix\n\nGenerated by scripts/awx-parity.mjs from installed awx-axi ${pkg.version}.\nSee [scope, controls and delivery plan](awx-parity.md) and [machine-readable matrix](../tools/inventories/awx-axi-parity.json).\nDo not edit this generated file.\n\n## Target authorization policy\n\nThis is the target policy, not the [current implemented write boundary](safety.md#write-gates-by-tool).\n\n- read: ${targetPolicy.read}.\n- write: ${targetPolicy.write}.\n\nThere are no separate destructive or security authorization tiers.\nUpstream config/delete/security tags and native gates remain implementation constraints, not administrator permission tiers.\nArtium must supply the appropriate native gates under the single writes switch.\nAll operations retain tenant/account access, managed HTTPS origin, verified TLS, credential isolation and AWX resource authorization.\nClient-local managed equivalents never permit caller-controlled runner configuration.\nHelp itself is read-only; a mutation row's authorization governs preview/execution, not help.\n\n## Global flags\n\n${table(globals)}\n\n${table(versionFlags.map(flag => ({ ...flag, command: flag.name })))}\n\n## Commands\n\n${table(commands)}\n\n## Upstream nested aliases\n\n${table(aliases)}\n\n## Flags by command\n\nEvery row inherits its command's reasons and restrictions from the JSON; conditional upstream effects do not add target permission tiers.\nGlobal selection flags above apply to every command; per-command --help is included below.\nSecret/file inputs use the TD-066 private file channel. Structured flags accept inline values or @local-file; credential inputs-file and password-file also accept stdin (-).\n\n${commands.map(command => `### ${command.command}\n\n${command.reason ?? command.note ?? 'See command controls above.'}\n\n| Flag | Value | Status | Slice | Target authorization | Secret / file / stdin |\n| --- | --- | --- | --- | --- | --- |\n${command.flags.map(flag => `| --${flag.name} | ${flag.takesValue ? 'value' : 'boolean'} | ${flag.status} | ${flag.targetSlice} | ${flag.authorization} | ${[flag.secret && 'potential secret', flag.file && 'file', flag.stdin && 'stdin', flag.outputFile && 'output file'].filter(Boolean).join(', ') || 'none'} |`).join('\n')}\n`).join('\n')}\n`
for (const [path, contents] of [['tools/inventories/awx-axi-parity.json', JSON.stringify(data, null, 2) + '\n'], ['docs/awx-parity-matrix.md', matrix]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) writeFileSync(destination, contents)
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error(`AWX parity matrix stale: ${path}; run node scripts/awx-parity.mjs --write and review classifications`)
}
console.log(`parity: awx-axi ${pkg.version}, ${commands.length} commands, ${aliases.length} aliases, ${commands.reduce((count, route) => count + route.flags.length, 0)} command flags, ${globals.length} selection globals, ${versionFlags.length} version flags`)
