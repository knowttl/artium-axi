import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
const compiled = await build({ entryPoints: ['src/shared/kubernetes.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { kubernetesHostedCommands } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`) as typeof import('../src/shared/kubernetes.js')

type Flag = { name: string, short: string, type: string, effect: string, default: string }
type Command = { path: string, effect: string, flags: Flag[], aliases: string[], compatibilityLimit?: string }
const root = new URL('../tools/', import.meta.url)
const base = new URL('node_modules/@knowttl/kubernetes-axi/', root)
const read = (path: string) => readFileSync(new URL(path, base), 'utf8')
const pkg = JSON.parse(read('package.json')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pins[pkg.name].version !== pkg.version) throw new Error('Kubernetes installed version differs from its pin')
const metadata = JSON.parse(read('command-metadata.json')) as { commands: Command[] }
const kubectlPins = JSON.parse(read('kubectl-pins.json')) as { version: string, supportedServerMinors: number[],
  binaries: Record<string, { file: string, sha256: string }> }
const kubectl = { version: kubectlPins.version, supportedServerMinors: kubectlPins.supportedServerMinors, binaries: kubectlPins.binaries }
const compactFlags: Record<string, string[]> = {
  '': ['namespace'], version: [], get: ['namespace', 'all-namespaces', 'selector', 'field-selector', 'output', 'continue'],
  'api-versions': [], 'api-resources': [], 'top node': ['namespace', 'selector'], 'top pod': ['namespace', 'all-namespaces', 'selector'],
}
const compactCommands = ['logs', 'describe', 'explain', 'rollout history', 'rollout status']
const reads = metadata.commands.filter(command => ['read', 'authorization'].includes(command.effect)
  && !['events', 'wait', 'top', 'auth', 'options'].includes(command.path) && !command.compatibilityLimit)
const mutations = metadata.commands.filter(command => (command.effect === 'clusterWrite' || command.path === 'create token') && !command.compatibilityLimit)
const safe = (command: Command, flag: Flag) => ['argument', 'presentation', 'stream'].includes(flag.effect)
  || command.path === 'get' && flag.name === 'raw'
function route(command: Command, native: boolean) {
  const selected = command.flags.filter(flag => safe(command, flag)
    && (native || !Object.hasOwn(compactFlags, command.path) || compactFlags[command.path].includes(flag.name) || flag.name === 'help'))
  if (command.path === 'get' && !native) selected.push({ name: 'continue', short: '', type: 'string', effect: 'argument', default: '' })
  return { command: (native ? 'native -- ' : '') + (command.path || 'home'), effect: 'read',
    flags: Object.fromEntries(selected.map(flag => [flag.name, flag.type === 'bool' ? 'boolean' : 'value'])),
    shortFlags: Object.fromEntries(selected.filter(flag => flag.short).map(flag => [flag.short, flag.name])) }
}
const home = metadata.commands.find(command => command.path === '')!
const commands = [route(home, false), ...reads.flatMap(command => [
  ...(Object.hasOwn(compactFlags, command.path) || compactCommands.includes(command.path) || command.effect === 'authorization' ? [route(command, false)] : []),
  route(command, true),
]), ...['auth status', 'doctor'].map(command => ({ command, effect: 'read', flags: { help: 'boolean' }, shortFlags: {} }))]
const writeCommands = mutations.map(command => ({ command: command.path, effect: 'write',
  flags: Object.fromEntries(command.flags.filter(flag => ['argument', 'presentation', 'stream', 'clusterWrite'].includes(flag.effect))
    .map(flag => [flag.name, flag.type === 'bool' ? 'boolean' : 'value'])) }))
const unsafeOverrides = [...new Set(['config', 'profile', 'native-config', 'trust-exec', 'credential-fd',
  ...metadata.commands.flatMap(command => command.flags.filter(flag => ['identity', 'secret', 'tls', 'impersonation', 'fileRead', 'localWrite', 'execution'].includes(flag.effect))
    .map(flag => flag.name)).filter(name => ![...commands, ...writeCommands].some(route => Object.hasOwn(route.flags, name)))])].sort()
const workflows = [
  ['prepare', 'prepare -- <mutation>', 'write'], ['preview', 'preview <request-key>', 'read'],
  ['confirm', 'confirm <request-key> --digest <exact-digest>', 'write'], ['server-dry-run', 'server-dry-run -- <mutation>', 'write'],
].map(([command, usage, effect]) => ({ command, usage, effect, flags: { help: 'boolean', ...(command === 'confirm' ? { digest: 'value' } : {}) } }))
function files(path: string): string[] {
  return readdirSync(new URL(path, base), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`])
}
const sources = ['package.json', 'axi-credential.schema.json', 'command-metadata.json', 'kubectl-pins.json',
  ...files('bin'), ...files('dist'), ...files('vendor'), 'skills/kubernetes-axi/SKILL.md'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex') }))
for (const binary of Object.values(kubectl.binaries)) {
  if (sources.find(source => source.path === `vendor/${binary.file}`)?.sha256 !== binary.sha256) throw new Error('Kubectl binary differs from its pin')
}
const data = { generatedBy: 'scripts/kubernetes-inventory.ts', tool: 'kubernetes-axi', package: pkg.name, ...pins[pkg.name],
  sources, credentialSchema: JSON.parse(read('axi-credential.schema.json')) as Record<string, unknown>, kubectl,
  adapterBoundary: { unsafeOverrides, blockedCommands: ['profile', 'config', 'setup', 'update'],
    nativeWrites: 'administrator-enabled prepare/preview/confirm and server-dry-run; direct mutations refused',
    streams: 'bounded byte sessions require explicit per-caller kind grants; mutation kinds also require Allow writes' },
  commands, writeCommands, workflows, healthRead: ['get', 'pods'], requirements: { timeoutMs: 65_000, runtime: 'node' },
  discovery: { commands: [...commands.filter(route => route.command !== 'home').map(route => route.command),
    ...workflows.map(workflow => workflow.usage), ...kubernetesHostedCommands], example: ['get', 'pods'],
    help: 'Read Kubernetes with the managed HTTPS origin, identity and cluster CA.\nUse compact get for bounded metadata, including Secret metadata without credential bytes.\nUse native -- for reviewed upstream reads and formats; rollout status requires --watch=false.\nIssuing CA trust is supported; saved strict leaf pins are unavailable.\nAdministrator-enabled mutations require prepare -- <mutation>, preview <request-key>, then confirm <request-key> --digest <exact-digest>; server-dry-run -- <mutation> is separately explicit.\nUse workspace create to stage regular files and session start for one bounded operation. Every session kind needs an explicit caller grant in administrator native settings; mutation kinds also require Allow writes.\nUse session show/output/confirm/cancel and session artifact for owned recovery and verified bytes. Workspace references use workspace:<path>; copy downloads use artifact:<path>.\nLogs and watch sessions start immediately as reads; other session kinds require native preview and exact-digest confirmation.\nUse an explicitly granted port-forward session with tunnel <session-id> --port <remote-port> for authenticated forwarding to local 127.0.0.1 listeners.\nService-account token issuance requires Allow writes and acquireCredential=true; use native prepare/preview/confirm, then credential <result-id> --credential-fd <fd> for one-shot delivery to a private writable pipe or socket numbered 5 or higher.\nLocal configuration, impersonation and interactive execution remain unavailable.\n' } }
const output = JSON.stringify(data, null, 2) + '\n'
const target = new URL('inventories/kubernetes-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(target, output)
else if (readFileSync(target, 'utf8') !== output) throw new Error('Kubernetes inventory is stale')
console.log(`inventory: kubernetes-axi ${pkg.version}, ${commands.length} read routes, kubectl ${kubectl.version}`)
