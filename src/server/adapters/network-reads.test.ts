import { expect, test } from 'vitest'
import { createNetworkReadAdapter } from './network-reads.js'

const source = { getCredential: async () => ({ origin: 'https://synthetic.invalid', apiKey: 'CANARY-unifi-key' }) }

test.each([[], ['--help'], ['--site', 'synthetic-site']])('UniFi retains the empty-command dashboard for %j', async (...args) => {
  const call = await createNetworkReadAdapter('unifi-axi', source).prepare(args, { id: 'synthetic', tool: 'unifi-axi', revision: 1 })
  expect(call.args.slice(1)).toEqual(args)
  expect(call.invocation?.command).toBe('home')
})

test.each([['home'], ['home', '--help']])('UniFi rejects the unsupported explicit home command %j', (...args) => {
  expect(() => createNetworkReadAdapter('unifi-axi', source).validateArgs(args)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test.each(['status', 'log', 'wait'])('Proxmox task %s rejects journal input', action => {
  const adapter = createNetworkReadAdapter('proxmox-axi', source)
  expect(() => adapter.validateArgs(['task', action, '--journal', 'synthetic-intent'])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})
