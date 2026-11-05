import { encode } from '@toon-format/toon'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { resolveProxmoxResult } from '../shared/proxmox-commands.js'
import type { Client } from './http.js'
import { deliverPrivateResult } from './private-result.js'

export async function proxmoxPrivateResult(createClient: () => Client, supplied: string[], output: (text: string) => void): Promise<boolean> {
  if (supplied[0] !== 'result') return false
  const { json, args, help } = resolveProxmoxResult(supplied)
  if (help) {
    output((json ? JSON.stringify : encode)({ usage: 'artium-axi proxmox-axi result take <operation> <id>',
      help: ['Set PROXMOX_AXI_RESULT_FD to an inherited private writable pipe descriptor of at least 5.',
        'Retrieve once within five minutes using the same caller, sign-in family, operation, credential and trust binding.',
        'The destination is checked before consumption. Framed protected bytes never enter routine output or files; interrupted delivery is not retried.'] }) + '\n')
    return true
  }
  await deliverPrivateResult(createClient, { tool: 'proxmox-axi', operation: args[2], id: args[3],
    fd: process.env.PROXMOX_AXI_RESULT_FD, json,
    ...(inventory.streamCommands.some(route => route.operationId === args[2] && /\/(spiceproxy|spiceshell)$/.test(route.path)) ? { maxBytes: 4 * 1024 * 1024 } : {}) }, output)
  return true
}
