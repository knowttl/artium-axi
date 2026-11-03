import { encode } from '@toon-format/toon'
import { z } from 'zod'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'
import { deliverPrivateResult } from './private-result.js'

export async function proxmoxPrivateResult(createClient: () => Client, supplied: string[], output: (text: string) => void): Promise<boolean> {
  if (supplied[0] !== 'result') return false
  const json = supplied.includes('--json'), args = supplied.filter(arg => arg !== '--json')
  if (args.at(-1) === '--help' && (args.length === 2 || args.length === 3 && args[1] === 'take')) {
    output((json ? JSON.stringify : encode)({ usage: 'artium-axi proxmox-axi result take <operation> <id>',
      help: ['Set PROXMOX_AXI_RESULT_FD to an inherited private writable pipe descriptor of at least 5.',
        'Retrieve once within five minutes using the same caller, sign-in family, operation, credential and trust binding.',
        'The destination is checked before consumption. Framed protected bytes never enter routine output or files; interrupted delivery is not retried.'] }) + '\n')
    return true
  }
  if (args.length !== 4 || args[1] !== 'take' || !inventory.writeOperations.includes(args[2]) || !z.uuid().safeParse(args[3]).success) {
    throw new ArtiumError('INVALID_INPUT')
  }
  await deliverPrivateResult(createClient, { tool: 'proxmox-axi', operation: args[2], id: args[3],
    fd: process.env.PROXMOX_AXI_RESULT_FD, json,
    ...(inventory.streamCommands.some(route => route.operationId === args[2] && /\/(spiceproxy|spiceshell)$/.test(route.path)) ? { maxBytes: 4 * 1024 * 1024 } : {}) }, output)
  return true
}
