import { join } from 'node:path'
import { expect, test } from 'vitest'
import beyondtrustInventory from '../tools/inventories/beyondtrust-axi.json' with { type: 'json' }
import checkpointInventory from '../tools/inventories/checkpoint-axi.json' with { type: 'json' }
import hybridInventory from '../tools/inventories/hybrid-axi.json' with { type: 'json' }
import mgInventory from '../tools/inventories/mg-axi.json' with { type: 'json' }
import tenableInventory from '../tools/inventories/tenable-axi.json' with { type: 'json' }
import vectraInventory from '../tools/inventories/vectra-axi.json' with { type: 'json' }
import { beyondtrustWritePolicy, createBeyondtrustAdapter } from '../src/server/adapters/beyondtrust.js'
import { checkpointWritePolicy, createCheckpointAdapter } from '../src/server/adapters/checkpoint.js'
import { createFalconAdapter } from '../src/server/adapters/falcon.js'
import { createGiteaAdapter } from '../src/server/adapters/gitea.js'
import { createHybridAdapter, hybridWritePolicy } from '../src/server/adapters/hybrid.js'
import { createKubernetesAdapter } from '../src/server/adapters/kubernetes.js'
import { createProxmoxAdapter } from '../src/server/adapters/proxmox.js'
import { createTechnitiumAdapter } from '../src/server/adapters/technitium.js'
import { createUnifiAdapter } from '../src/server/adapters/unifi.js'
import { createMgAdapter, mgManifest, mgWritePolicy } from '../src/server/adapters/mg.js'
import { mgReadCommands, vectraReadCommands } from '../src/server/adapters/reviewed-reads.js'
import { createTenableAdapter, tenableWritePolicy } from '../src/server/adapters/tenable.js'
import { createVectraAdapter, vectraManifest, vectraWritePolicy } from '../src/server/adapters/vectra.js'

const source = { getCredential: async () => ({}) }
const writeLog = '/tmp/synthetic-write-authorization/writes.log'
const writeCommands = (inventory: { commands: { command: string, effect?: string }[] }) =>
  inventory.commands.filter(route => route.effect === 'write').map(route => route.command)

const tools = [
  { tool: 'beyondtrust-axi', adapter: createBeyondtrustAdapter(source, writeLog), policy: beyondtrustWritePolicy,
    commands: writeCommands(beyondtrustInventory), extra: [] },
  { tool: 'checkpoint-axi', adapter: createCheckpointAdapter(source, writeLog), policy: checkpointWritePolicy,
    commands: writeCommands(checkpointInventory), extra: ['event.action.synthetic'] },
  { tool: 'hybrid-axi', adapter: createHybridAdapter(source, writeLog), policy: hybridWritePolicy,
    commands: writeCommands(hybridInventory), extra: [] },
  { tool: 'tenable-axi', adapter: createTenableAdapter(source, writeLog), policy: tenableWritePolicy,
    commands: writeCommands(tenableInventory), extra: [] },
  { tool: 'mg-axi', adapter: createMgAdapter(source, writeLog), policy: mgWritePolicy, extra: [],
    commands: mgInventory.commands.map(route => route.command).filter(command => !mgReadCommands.has(command)
      && !mgManifest.downloadCommands.includes(command)
      && mgManifest.allowedCommands.some(allowed => command === allowed || command.startsWith(`${allowed} `))) },
  { tool: 'vectra-axi', adapter: createVectraAdapter(source, writeLog), policy: vectraWritePolicy, extra: [],
    commands: vectraInventory.commands.map(route => route.command)
      .filter(command => !vectraReadCommands.has(command) && !vectraManifest.blockedCommands.includes(command.split(' ')[0])) },
]
const commands = tools.flatMap(item => item.commands.map(command => ({ ...item, command })))
const rawApiWrite = /^api (?:post|put|patch|delete)$/
const accepts = (tool: string, command: string, operation: string) => {
  try { tools.find(item => item.tool === tool)!.adapter.authorizeOperation!(command, { writes: { allowWrites: true, operations: [operation] } }) }
  catch { return false }
  return true
}

test.each(commands)('$tool $command is accepted for an operation the administrator can select', ({ tool, policy, command, extra }) => {
  const selectable = [...policy.read({}).supportedOperations ?? [], ...extra]
  expect(rawApiWrite.test(command) || selectable.some(operation => accepts(tool, command, operation))).toBe(true)
})

test.each(commands)('$tool $command is refused when writes are off or its operation is not selected', ({ adapter, policy, command, extra }) => {
  const selectable = [...policy.read({}).supportedOperations ?? [], ...extra]
  expect(() => adapter.authorizeOperation!(command, { writes: { allowWrites: false, operations: selectable } })).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  expect(() => adapter.authorizeOperation!(command, {})).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  if (!rawApiWrite.test(command)) {
    expect(() => adapter.authorizeOperation!(command, { writes: { allowWrites: true, operations: [] } })).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  }
})

test.each([
  ['beyondtrust-axi', 'user preferences set', 'user.preferences', 'user.disable'],
  ['checkpoint-axi', 'exception create', 'exception.url.create', 'exception.url.update'],
  ['checkpoint-axi', 'exception remove', 'exception.click-time.remove', 'exception.click-time.remove-items'],
  ['checkpoint-axi', 'exception remove-items', 'exception.click-time.remove-items', 'exception.click-time.remove'],
  ['checkpoint-axi', 'event action', 'event.action.synthetic', 'email.restore'],
  ['hybrid-axi', 'quick-scan submit', 'convertQuickScan', 'submitUrl'],
  ['tenable-axi', 'tag assignment remove', 'tags-assign-asset-tags', 'tags-create-tag-value'],
  ['mg-axi', 'entra user revoke-sessions', 'entra.user.revokeSessions', 'entra.user.update'],
  ['mg-axi', 'entra group member add', 'mg.entra.group.member.add', 'entra.user.update'],
  ['vectra-axi', 'assignment set', 'rux.host.assignment.reassign', 'rux.host.assignment.resolve'],
  ['vectra-axi', 'assignment resolve', 'qux.account.assignment.resolve', 'qux.account.assignment.create'],
  ['vectra-axi', 'triage rule create', 'qux.triage-rule.create', 'qux.triage-rule.delete'],
  ['vectra-axi', 'notification destination edit', 'rux.notification-destination.edit', 'rux.notification-destination.create'],
  ['vectra-axi', 'group member add', 'qux.group.member.set', 'qux.group.delete'],
  ['vectra-axi', 'detection close', 'qux.detection.close-bulk', 'qux.detection.open'],
] as const)('%s %s accepts %s and refuses %s', (tool, command, accepted, refused) => {
  expect(accepts(tool, command, accepted)).toBe(true)
  expect(accepts(tool, command, refused)).toBe(false)
})

const kubernetes = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
const selected = (operations: string[]) => ({ writes: { allowWrites: true, operations } })
const hosted = (operations: string[]) => ({ hostWrites: { allowWrites: true, operations }, writes: { allowWrites: true, operations } })

test.each([
  { adapter: createUnifiAdapter(source, writeLog), command: 'acl-rule create', accepted: selected(['createAclRule']), refused: selected(['deleteAclRule']) },
  { adapter: createFalconAdapter(source, writeLog), command: 'search start', accepted: selected(['search start']), refused: selected(['search stop']) },
  { adapter: createGiteaAdapter(source, writeLog), command: 'issue create', accepted: selected(['issueCreateIssue']), refused: selected(['issueEditIssue']),
    args: ['issue', 'create', '--repo', 'owner/repository', '--title', 'Synthetic', '--allow-write', 'issueCreateIssue', '--preview'] },
  { adapter: createGiteaAdapter(source, writeLog), command: 'issue create', accepted: selected(['issueCreateIssue', 'issueDeleteComment']), refused: selected(['issueCreateIssue']),
    args: ['issue', 'create', '--repo', 'owner/repository', '--title', 'Synthetic', '--allow-write', 'issueCreateIssue,issueDeleteComment', '--preview'] },
  { adapter: createTechnitiumAdapter(source, writeLog), command: 'admin cluster init', accepted: hosted(['OP-119']),
    refused: { hostWrites: { allowWrites: true, operations: ['OP-119'] }, writes: { allowWrites: true, operations: ['OP-120'] } } },
  { adapter: createProxmoxAdapter(source, writeLog), command: 'task cancel', accepted: { hostWrites: { allowWrites: true, operations: ['OP-DELETE-d6b1eb65f2'] } },
    refused: { hostWrites: { allowWrites: true, operations: ['OP-DELETE-db1a319dfa'] } } },
  { adapter: kubernetes, command: 'create token', accepted: { allowWrites: true, acquireCredential: true }, refused: { allowWrites: true } },
])('$adapter.name $command is authorized only by the administrator allow-list selection', ({ adapter, command, accepted, refused, args }) => {
  const authorize = (settings: Record<string, unknown>) => () => adapter.authorizeOperation!(command, settings, args)
  expect(authorize(refused)).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  expect(authorize(accepted)).not.toThrow()
})
