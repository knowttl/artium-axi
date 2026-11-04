import { expect, test } from 'vitest'
import { createProxmoxAdapter } from './proxmox.js'

const adapter = createProxmoxAdapter({ getCredential: async () => ({}) })

test.each([
  ['lxc', 'delete'], ['lxc', 'rootfs'], ['lxc', 'mp0'], ['lxc', 'net0'], ['lxc', 'cpulimit'],
  ['qemu', 'delete'], ['qemu', 'scsi0'], ['qemu', 'net0'], ['qemu', 'sshkeys'], ['qemu', 'agent'],
])('rejects unreviewed %s configuration flag %s', (guest, field) => {
  expect(() => adapter.validateArgs(['set', `/nodes/{node}/${guest}/{vmid}/config`, '--preview', `--api-${field}`, '1']))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining(`Unknown flag --api-${field}`) }))
})

test.each(['lxc', 'qemu'])('preserves %s configuration flags and protected vendor input', guest => {
  expect(() => adapter.validateArgs(['put', `/nodes/{node}/${guest}/{vmid}/config`, '--preview',
    '--api-node', 'synthetic', '--api-vmid', '101', '--api-memory', '512', '--protected-input'],
  { stdin: JSON.stringify({ api: { net0: 'synthetic-network' }, secrets: {} }) })).not.toThrow()
})
