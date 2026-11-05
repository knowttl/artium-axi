import { expect, test } from 'vitest'
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

const source = { getCredential: async () => ({}) }
const log = '/tmp/synthetic-classifier.log'
const adapters = [createAwxAdapter(source), createAzAdapter(source, log), createBeyondtrustAdapter(source, log),
  createCheckpointAdapter(source, log), createHybridAdapter(source, log), createFalconAdapter(source, log),
  createGiteaAdapter(source, log), createProxmoxAdapter(source, log), createTechnitiumAdapter(source, log),
  createTenableAdapter(source, log), createUnifiAdapter(source, log)]

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
] as const)('%s classifies %s from its inventory even for help', (tool, command, effect) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify!(command.split(' ').concat('--help')))
    .toEqual({ command, effect })
})

test.each(adapters)('$name classifies an unknown command as write', adapter => {
  expect(adapter.classify!(['synthetic-unknown']).effect).toBe('write')
})
