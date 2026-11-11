import { z } from 'zod'
import shodanInventory from '../../tools/inventories/shodan-axi.json' with { type: 'json' }
import { kubernetesSessionKind } from './kubernetes.js'

export interface UserGrantPolicy {
  title: string
  description: string
  operations: readonly { id: string, label: string }[]
}

const unique = <Item extends { id: string }>(items: Item[]) => [...new Map(items.map(item => [item.id, item])).values()]
const confirmed = (kind: string) => shodanInventory.confirmedWrites.filter(entry => entry.kind === kind)

// Per-person grants stay per person: each policy maps Artium user IDs to exact operations.
// The catalogue lists what the administrator screen may grant; ceilings stay in the native settings.
export const userGrantPolicies: Record<string, Record<string, UserGrantPolicy>> = {
  'kubernetes-axi': {
    sessions: { title: 'Interactive sessions', description: 'People who may start bounded watch, logs, exec, attach, apply, create, cp and port-forward sessions.',
      operations: kubernetesSessionKind.options.map(kind => ({ id: kind, label: kind })) },
  },
  'shodan-axi': {
    scans: { title: 'Scans', description: 'People who may submit scans. Collecting results also needs a stream session grant for OP-046.',
      operations: [{ id: 'OP-009', label: 'scan submit' }] },
    sessions: { title: 'Stream sessions', description: 'People who may start banner and threat stream sessions.',
      operations: shodanInventory.streamCommands.filter(entry => /^OP-\d{3}$/.test(entry.operation))
        .flatMap(entry => [entry.operation, ...entry.selectors].map(id => ({ id, label: entry.command }))) },
    writes: { title: 'Confirmed writes', description: 'People who may run each confirmed alert, notifier and organization change.',
      operations: unique(confirmed('write').flatMap(entry => entry.grants.map(id => ({ id, label: entry.command })))) },
    exports: { title: 'Exports', description: 'People who may start retained download exports.',
      operations: confirmed('export').map(entry => ({ id: entry.grants[0]!, label: entry.command })) },
  },
}

export const userGrantPolicyNameSchema = z.enum(['sessions', 'scans', 'writes', 'exports'])
