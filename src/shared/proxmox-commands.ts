import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { ArtiumError } from './errors.js'
import { z } from 'zod'

export const proxmoxHostedRoutes = [{ command: 'stream limits', effect: 'read' }, { command: 'result take', effect: 'write' }]

export function resolveProxmoxStream(supplied: readonly string[]) {
  const separator = supplied.indexOf('--'), local = supplied.slice(1, separator < 0 ? undefined : separator)
  const json = local.includes('--json'), options = local.filter(arg => arg !== '--json')
  if (local.filter(arg => arg === '--json').length > 1) throw new ArtiumError('INVALID_INPUT')
  const args = supplied.slice(separator + 1)
  const route = inventory.streamCommands.find(route => route.command === args.slice(0, 3).join(' '))
  return { separator, json, options, args, route }
}

export function resolveProxmoxResult(supplied: readonly string[]) {
  const json = supplied.includes('--json'), args = supplied.filter(arg => arg !== '--json')
  const help = args.at(-1) === '--help' && (args.length === 2 || args.length === 3 && args[1] === 'take')
  if (!help && (args.length !== 4 || args[1] !== 'take' || !inventory.writeOperations.includes(args[2]) || !z.uuid().safeParse(args[3]).success)) {
    throw new ArtiumError('INVALID_INPUT')
  }
  return { json, args, help }
}
