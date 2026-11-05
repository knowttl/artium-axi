import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { createAdoAdapter } from './ado.js'
import { createAwxAdapter } from './awx.js'
import { createAzAdapter } from './az.js'
import { createBeyondtrustAdapter } from './beyondtrust.js'
import { createCheckpointAdapter } from './checkpoint.js'
import { createHybridAdapter } from './hybrid.js'
import { createFalconAdapter } from './falcon.js'
import { createGiteaAdapter } from './gitea.js'
import { createProxmoxAdapter } from './proxmox.js'
import { createTechnitiumAdapter } from './technitium.js'
import { createTenableAdapter } from './tenable.js'
import { createUnifiAdapter } from './unifi.js'
import { createGhAdapter } from './gh.js'
import { createKubernetesAdapter } from './kubernetes.js'
import { createLdapAdapter } from './ldap.js'
import { createMgAdapter } from './mg.js'
import { createSshAdapter } from './ssh.js'
import { createVectraAdapter } from './vectra.js'
import { openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { SshHosts } from '../store/ssh-hosts.js'
import { kubernetesHostedCommands } from '../../shared/kubernetes.js'
import proxmoxInventory from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }

const source = { getCredential: async () => ({}) }
const log = '/tmp/synthetic-classifier.log'
const directory = mkdtempSync(join(tmpdir(), 'artium-classifier-'))
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
const db = openStore(join(directory, 'data.db'), provider)
const adapters = [createAwxAdapter(source), createAzAdapter(source, log), createBeyondtrustAdapter(source, log),
  createCheckpointAdapter(source, log), createHybridAdapter(source, log), createFalconAdapter(source, log),
  createGiteaAdapter(source, log), createProxmoxAdapter(source, log), createTechnitiumAdapter(source, log),
  createTenableAdapter(source, log), createUnifiAdapter(source, log), createAdoAdapter(source), createGhAdapter(source),
  await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js')),
  createLdapAdapter(source), createMgAdapter(source, log), createVectraAdapter(source, log),
  createSshAdapter(new SshHosts(db, provider), log, join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js'))]
afterAll(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
afterEach(() => { vi.unstubAllEnvs() })

type Route = { command: string, effect?: string, canonicalCommand?: string }
const inventoryCases = adapters.flatMap(adapter => {
  const inventory = JSON.parse(readFileSync(new URL(`../../../tools/inventories/${adapter.name}.json`, import.meta.url), 'utf8')) as {
    commands: Route[], writeCommands?: Route[], workflows?: Route[], managedCommands?: Route[], streamCommands?: Route[]
  }
  return [...inventory.commands, ...(inventory.writeCommands ?? []), ...(inventory.workflows ?? []), ...(inventory.managedCommands ?? []), ...(inventory.streamCommands ?? [])].map(route => {
    const reviewedRead = adapter.name === 'ldap-axi'
    const workflow = inventory.workflows?.includes(route)
    const effect = !workflow && (reviewedRead || route.effect === 'read' || route.effect === 'local') ? 'read' : 'write'
    return { adapter, command: route.command, canonical: route.canonicalCommand ?? (route.command || 'home'), effect }
  })
})

test.each(inventoryCases.filter(({ adapter }) => !['mg-axi', 'vectra-axi'].includes(adapter.name)))('$adapter.name inventory command $command has its reviewed class', ({ adapter, command, canonical, effect }) => {
  expect(adapter.classify(command ? command.split(' ') : [])).toEqual({ command: canonical, effect })
})

test.each(inventoryCases.filter(({ adapter }) => ['mg-axi', 'vectra-axi'].includes(adapter.name)))('$adapter.name inventory command $command has its canonical name', ({ adapter, command, canonical }) => {
  expect(adapter.classify(command ? command.split(' ') : []).command).toBe(canonical)
})

test.each(['--version', '-v'])('ado-axi preserves the canonical version command for %s', flag => {
  const adapter = adapters.find(adapter => adapter.name === 'ado-axi')!
  adapter.validateArgs([flag])
  expect(adapter.classify([flag])).toEqual({ command: 'version', effect: 'read' })
})

test.each([
  'awx-axi', 'az-axi', 'beyondtrust-axi', 'checkpoint-axi', 'falcon-axi', 'gh-axi', 'gitea-axi',
  'hybrid-axi', 'mg-axi', 'proxmox-axi', 'technitium-axi', 'tenable-axi', 'unifi-axi', 'vectra-axi', 'ssh-axi',
].flatMap(tool => ['--version', '-v', '-V'].map(flag => ({ tool, flag }))))('$tool recognizes $flag as an informational read', ({ tool, flag }) => {
  const adapter = adapters.find(adapter => adapter.name === tool)!
  adapter.validateArgs([flag])
  expect(adapter.classify([flag])).toEqual({ command: 'version', effect: 'read' })
})

test.each([
  ['awx-axi', 'home'], ['az-axi', 'home'], ['beyondtrust-axi', 'home'], ['checkpoint-axi', 'home'],
  ['falcon-axi', 'home'], ['gh-axi', 'help'], ['gitea-axi', 'home'], ['hybrid-axi', 'home'],
  ['mg-axi', 'home'], ['proxmox-axi', 'home'], ['technitium-axi', 'home'], ['tenable-axi', 'home'], ['unifi-axi', 'home'],
] as const)('%s recognizes top-level help as an informational read', (tool, command) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify(['--help'])).toEqual({ command, effect: 'read' })
})

test.each([
  ['awx-axi', ['job', '--help'], 'job'],
  ['falcon-axi', ['detection', '--help'], 'detection'],
  ['gh-axi', ['issue', '--help'], 'issue'],
  ['gitea-axi', ['repo', '--help'], 'repo'],
  ['proxmox-axi', ['get', '--help'], 'get'],
  ['unifi-axi', ['dpi', 'application', '--help'], 'dpi application'],
  ['proxmox-axi', ['stream', '--help'], 'stream'],
  ['proxmox-axi', ['stream', '--json', '--help'], 'stream'],
  ['kubernetes-axi', ['workspace', '--help'], 'workspace'],
  ['kubernetes-axi', ['--json', 'workspace', '--help'], 'workspace'],
  ['kubernetes-axi', ['session', '--help'], 'session'],
  ['kubernetes-axi', ['--json', 'session', '--help'], 'session'],
] as const)('%s recognizes group help %j as an informational read', (tool, args, command) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify(args)).toEqual({ command, effect: 'read' })
})

test.each([
  ['awx-axi', ['job', 'synthetic-unknown', '--help']],
  ['falcon-axi', ['detection', 'synthetic-unknown', '--help']],
  ['gh-axi', ['issue', 'synthetic-unknown', '--help']],
  ['gitea-axi', ['repo', 'synthetic-unknown', '--help']],
  ['proxmox-axi', ['get', 'synthetic-unknown', '--help']],
  ['unifi-axi', ['dpi', 'synthetic-unknown', '--help']],
  ['vectra-axi', ['detection', 'synthetic-unknown', '--help']],
  ['kubernetes-axi', ['workspace', 'synthetic-unknown', '--help']],
  ['kubernetes-axi', ['session', 'synthetic-unknown', '--help']],
] as const)('%s keeps unknown subcommands with help write-classified: %j', (tool, args) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify(args).effect).toBe('write')
})

test.each(adapters)('$name keeps unknown commands with help write-classified', adapter => {
  expect(adapter.classify(['synthetic-unknown', '--help']).effect).toBe('write')
})

test.each([
  ['exec', ['exec', 'synthetic', '--command', 'true', '--confirm'], 'write'],
  ['connection open', ['connection', 'open', 'synthetic'], 'read'],
  ['connection list', ['--json', 'connection', 'list'], 'read'],
  ['connection show', ['connection', 'show', '11111111-1111-4111-8111-111111111111'], 'read'],
  ['connection set', ['connection', 'set', '11111111-1111-4111-8111-111111111111', '--idle-timeout', '5m'], 'read'],
  ['connection close', ['connection', 'close', '11111111-1111-4111-8111-111111111111', '--confirm'], 'write'],
  ['execution list', ['--json', 'execution', 'list'], 'read'],
  ['execution show', ['execution', 'show', '--request-key', '11111111-1111-4111-8111-111111111111'], 'read'],
  ['execution cancel', ['execution', 'cancel', '11111111-1111-4111-8111-111111111111', '--confirm'], 'write'],
] as const)('SSH managed %s resolves arguments', (command, args, effect) => {
  expect(adapters.find(adapter => adapter.name === 'ssh-axi')!.classify(args)).toEqual({ command, effect })
})

test.each(proxmoxInventory.streamCommands)('Proxmox hosted stream resolves $command', route => {
  expect(adapters.find(adapter => adapter.name === 'proxmox-axi')!.classify(['stream', '--json', '--', ...route.command.split(' '), '--help']))
    .toEqual({ command: route.command, effect: route.effect })
})

test.each([
  ['stream limits', ['stream', 'limits', '--json'], 'read'],
  ['result take', ['result', 'take', proxmoxInventory.writeOperations[0], '11111111-1111-4111-8111-111111111111', '--json'], 'write'],
] as const)('Proxmox hosted %s resolves arguments', (command, args, effect) => {
  expect(adapters.find(adapter => adapter.name === 'proxmox-axi')!.classify(args)).toEqual({ command, effect })
})

test.each([
  ['workspace create', ['workspace', 'create', '/synthetic'], 'write'],
  ['workspace show', ['workspace', 'show', '11111111-1111-4111-8111-111111111111'], 'read'],
  ['workspace download', ['workspace', 'download', '11111111-1111-4111-8111-111111111111', 'file', '--output', '/synthetic/file'], 'read'],
  ['workspace delete', ['workspace', 'delete', '11111111-1111-4111-8111-111111111111'], 'write'],
  ['session list', ['--json', 'session', 'list'], 'read'],
  ['session start exec', ['session', 'start', 'exec', '--', 'exec', 'synthetic', '--', 'true'], 'write'],
  ['session show', ['session', 'show', '11111111-1111-4111-8111-111111111111', '--wait'], 'read'],
  ['session output', ['session', 'output', '11111111-1111-4111-8111-111111111111', '--after', '1'], 'read'],
  ['session confirm', ['session', 'confirm', '11111111-1111-4111-8111-111111111111', '--digest', 'a'.repeat(64)], 'write'],
  ['session cancel', ['session', 'cancel', '11111111-1111-4111-8111-111111111111', '--confirm'], 'write'],
  ['session artifact', ['session', 'artifact', '11111111-1111-4111-8111-111111111111', 'file', '--output', '/synthetic/file'], 'read'],
  ['tunnel', ['--json', 'tunnel', '11111111-1111-4111-8111-111111111111', '--port', '8080'], 'write'],
  ['credential', ['credential', '11111111-1111-4111-8111-111111111111', '--credential-fd', '5'], 'write'],
] as const)('Kubernetes hosted %s resolves arguments', (command, args, effect) => {
  expect(adapters.find(adapter => adapter.name === 'kubernetes-axi')!.classify(args)).toEqual({ command, effect })
})

test.each(kubernetesHostedCommands.map(usage => {
  const words = usage.split(' ')
  const command = words.slice(0, ['tunnel', 'credential'].includes(words[0]) ? 1 : 2).join(' ')
  return { command, args: [...command.split(' '), '--help'] }
}))('Kubernetes hosted help resolves $command', ({ command, args }) => {
  expect(adapters.find(adapter => adapter.name === 'kubernetes-axi')!.classify(args).command).toBe(command)
})

test.each([
  ['vectra-axi', ['--synthetic-unknown']],
  ['vectra-axi', ['--synthetic-unknown=value']],
  ['vectra-axi', ['--help', 'synthetic-unknown']],
  ['vectra-axi', ['detection', 'list', 'synthetic-unknown']],
  ['vectra-axi', ['detection', 'list', '--synthetic-unknown']],
  ['vectra-axi', ['detection', 'list', '--limit']],
  ['vectra-axi', ['detection', 'list', '--limit=']],
  ['vectra-axi', ['detection', 'list', '--all=false']],
  ['vectra-axi', ['detection', 'list', '--help', '--help']],
  ['ssh-axi', ['connection', 'synthetic-unknown']],
  ['proxmox-axi', ['stream', '--', 'synthetic-unknown']],
  ['proxmox-axi', ['result', 'synthetic-unknown']],
  ['kubernetes-axi', ['session', 'synthetic-unknown']],
  ['kubernetes-axi', ['workspace', 'synthetic-unknown']],
  ['kubernetes-axi', ['session', 'list', '--synthetic-unknown']],
  ['proxmox-axi', ['stream', '--', 'transfer', 'get', '/nodes/{node}/tasks/{upid}/log', '--synthetic-unknown']],
] as const)('%s unrecognized input remains write', (tool, args) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify(args)).toEqual({ command: 'unknown', effect: 'write' })
})

test.each([
  { args: ['--help'], command: 'home' },
  { args: ['detection', 'list', '--limit', '10'], command: 'detection list' },
  { args: ['detection', 'list', '--limit=10', '--help'], command: 'detection list' },
  { args: ['host', 'show', '42', '--full'], command: 'host show' },
  { args: ['host', 'show', '--id', '42'], command: 'host show' },
])('Vectra recognizes read arguments $args', ({ args, command }) => {
  expect(adapters.find(adapter => adapter.name === 'vectra-axi')!.classify(args)).toEqual({ command, effect: 'read' })
})

test.each([
  ['awx-axi', 'job list', 'read'], ['awx-axi', 'job launch', 'write'],
  ['az-axi', 'auth status', 'read'], ['az-axi', 'tag update', 'write'],
  ['beyondtrust-axi', 'admin-request list', 'read'], ['beyondtrust-axi', 'admin-request create', 'write'],
  ['checkpoint-axi', 'email search', 'read'], ['checkpoint-axi', 'email quarantine', 'write'],
  ['hybrid-axi', 'api get', 'read'], ['hybrid-axi', 'hunting yara create', 'write'],
  ['falcon-axi', 'detection summary', 'read'], ['falcon-axi', 'host usb', 'write'],
  ['gitea-axi', 'repo view', 'read'], ['gitea-axi', 'issue upload', 'write'],
  ['proxmox-axi', 'task status', 'read'], ['proxmox-axi', 'task cancel', 'write'],
  ['technitium-axi', 'schema', 'read'], ['technitium-axi', 'admin cluster init', 'write'],
  ['tenable-axi', 'asset list', 'read'], ['tenable-axi', 'combination create', 'write'],
  ['unifi-axi', 'commands', 'read'], ['unifi-axi', 'acl-rule create', 'write'],
  ['mg-axi', 'entra user list', 'read'], ['mg-axi', 'entra user update', 'write'],
  ['vectra-axi', 'detection list', 'read'], ['vectra-axi', 'detection triage set', 'write'],
] as const)('%s classifies %s from its inventory even for help', (tool, command, effect) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify(command.split(' ').concat('--help')))
    .toEqual({ command, effect })
})

test('Azure DevOps API method overrides do not turn mutations into reads', () => {
  const adapter = adapters.find(item => item.name === 'ado-axi')!
  vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', JSON.stringify({ POST: ['_apis/projects'] }))
  expect(adapter.classify(['api', '_apis/projects', '--method', 'POST', '--body', '{}', '--help'])).toEqual({ command: 'api', effect: 'write' })
  expect(adapter.classify(['api', '--method', 'GET', '--help'])).toEqual({ command: 'api', effect: 'read' })
})

test.each(adapters)('$name classifies an unknown command as write', adapter => {
  expect(adapter.classify(['synthetic-unknown']).effect).toBe('write')
})

test('unresolved arguments are not returned as a command name', () => {
  const adapter = adapters.find(item => item.name === 'gh-axi')!
  expect(adapter.classify(['unknown', 'synthetic-value'])).toEqual({ command: 'unknown', effect: 'write' })
})

test.each(['gitea-axi', 'technitium-axi', 'unifi-axi'])('%s uses its parser home name for empty and help calls', tool => {
  const adapter = adapters.find(item => item.name === tool)!
  expect(adapter.classify([])).toEqual({ command: 'home', effect: 'read' })
  expect(adapter.classify(['--help'])).toEqual({ command: 'home', effect: 'read' })
})

test.each([
  ['api', 'PUT', 'repos/example/project/actions/secrets/name', '--input', '-', '--allow-write', 'updateRepoSecret', '--preview'],
  ['api', 'repos/example/project/actions/secrets/name', '-XPUT', '--input', '-', '--allow-write', 'updateRepoSecret', '--preview'],
])('Gitea raw API mutations remain writes during preview: %j', (...args) => {
  expect(adapters.find(adapter => adapter.name === 'gitea-axi')!.classify(args, { stdin: '{}' })).toEqual({ command: 'api', effect: 'write' })
})

test.each([
  { method: 'POST', path: 'repos/example/project/issues', operation: 'issueCreateIssue' },
  { method: 'PUT', path: 'repos/example/project/actions/secrets/name', operation: 'updateRepoSecret' },
  { method: 'PATCH', path: 'repos/example/project/issues/1', operation: 'issueEditIssue' },
  { method: 'DELETE', path: 'repos/example/project/issues/1', operation: 'issueDelete' },
].flatMap(({ method, path, operation }) => [
  [method, path], [path, '--method', method], [path, `--method=${method}`],
  [path, '-X', method], [path, `-X${method}`],
].flatMap(methodArgs => [
  { suffix: ['--input', '-', '--allow-write', operation, '--preview'], input: { stdin: '{}' } },
  { suffix: ['--input', '-', '--allow-write', operation, '--confirm', '11111111-1111-4111-8111-111111111111'], input: { stdin: '{}' } },
  { suffix: ['--help'], input: {} },
].map(({ suffix, input }) => ({ args: ['api', '--json', ...methodArgs, ...suffix], input })))))('Gitea API mutations use the parsed method with leading flags: $args', ({ args, input }) => {
  const adapter = adapters.find(adapter => adapter.name === 'gitea-axi')!
  adapter.validateArgs(args, input)
  expect(adapter.classify(args, input)).toEqual({ command: 'api', effect: 'write' })
})

test.each([
  ['api', '--json', 'repos/example/project/issues'],
  ['api', '--json', 'GET', 'repos/example/project/issues'],
  ['api', '--json', 'repos/example/project/issues', '--method=GET'],
  ['api', '--json', 'repos/example/project/issues', '-XGET'],
])('Gitea API reads remain reads with leading flags: %j', (...args) => {
  expect(adapters.find(adapter => adapter.name === 'gitea-axi')!.classify(args)).toEqual({ command: 'api', effect: 'read' })
})

test.each([
  ['gh-axi', ['issue', 'list', '-R', 'synthetic/repo'], ['-R', 'synthetic/repo', 'issue', 'list'], 'issue list'],
  ['ado-axi', ['work-item', 'get', '42'], ['wi', 'view', '42'], 'work-item get'],
  ['ado-axi', ['work-item', 'list', '--project', 'synthetic'], ['--project', 'synthetic', 'work-item', 'list'], 'work-item list'],
  ['kubernetes-axi', ['native', '--', 'get', 'pods', '-n', 'synthetic'], ['native', '--', 'get', '-n', 'synthetic', 'pods'], 'native -- get'],
] as const)('%s resolves equivalent arguments to the same classification', (tool, first, second, command) => {
  const adapter = adapters.find(item => item.name === tool)!
  expect(adapter.classify(first)).toEqual({ command, effect: 'read' })
  expect(adapter.classify(second)).toEqual({ command, effect: 'read' })
})
