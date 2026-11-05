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
import { mgReadCommands, vectraReadCommands } from './reviewed-reads.js'
import { openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { SshHosts } from '../store/ssh-hosts.js'

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
  createSshAdapter(new SshHosts(db, provider), log)]
afterAll(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
afterEach(() => { vi.unstubAllEnvs() })

type Route = { command: string, effect?: string, canonicalCommand?: string }
const inventoryCases = adapters.flatMap(adapter => {
  const inventory = JSON.parse(readFileSync(new URL(`../../../tools/inventories/${adapter.name}.json`, import.meta.url), 'utf8')) as {
    commands: Route[], writeCommands?: Route[], workflows?: Route[]
  }
  return [...inventory.commands, ...(inventory.writeCommands ?? []), ...(inventory.workflows ?? [])].map(route => {
    const reviewedRead = adapter.name === 'mg-axi' ? mgReadCommands.has(route.command)
      : adapter.name === 'vectra-axi' ? vectraReadCommands.has(route.command) : adapter.name === 'ldap-axi'
    const workflow = inventory.workflows?.includes(route)
    const effect = !workflow && (reviewedRead || route.effect === 'read' || route.effect === 'local') ? 'read' : 'write'
    return { adapter, command: route.command, canonical: route.canonicalCommand ?? (route.command || 'home'), effect }
  })
})

test.each(inventoryCases)('$adapter.name inventory command $command has its reviewed class', ({ adapter, command, canonical, effect }) => {
  expect(adapter.classify(command ? command.split(' ') : [])).toEqual({ command: canonical, effect })
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
  ['gh-axi', ['issue', 'list', '-R', 'synthetic/repo'], ['-R', 'synthetic/repo', 'issue', 'list'], 'issue list'],
  ['ado-axi', ['work-item', 'get', '42'], ['wi', 'view', '42'], 'work-item get'],
  ['ado-axi', ['work-item', 'list', '--project', 'synthetic'], ['--project', 'synthetic', 'work-item', 'list'], 'work-item list'],
  ['kubernetes-axi', ['native', '--', 'get', 'pods', '-n', 'synthetic'], ['native', '--', 'get', '-n', 'synthetic', 'pods'], 'native -- get'],
] as const)('%s resolves equivalent arguments to the same classification', (tool, first, second, command) => {
  const adapter = adapters.find(item => item.name === tool)!
  expect(adapter.classify(first)).toEqual({ command, effect: 'read' })
  expect(adapter.classify(second)).toEqual({ command, effect: 'read' })
})
