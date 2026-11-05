import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { z } from 'zod'
import inventory from '../../../tools/inventories/shodan-axi.json' with { type: 'json' }
import { shodanStreamStart } from '../../shared/shodan-stream.js'
import { ArtiumError } from '../../shared/errors.js'
import { toolPaths } from '../config.js'
import { verifyShodanPackage } from './shodan-package.js'

type Input = z.infer<typeof shodanStreamStart>
const selectorFlags = new Set(['--asn', '--countries', '--ports', '--vulns', '--custom-filters', '--alert', '--tags'])

// The package's own planner validates selector semantics without resolving a profile or key.
export async function inspectShodanStream(input: Input) {
  const route = inventory.streamCommands.find(entry => entry.command !== 'radar'
    && (entry.operation === input.operation || entry.selectors.includes(input.operation)))
  if (!route || input.selector.flag && (!selectorFlags.has(input.selector.flag) || !route.flags.includes(input.selector.flag))) throw new ArtiumError('INVALID_INPUT')
  verifyShodanPackage()
  const flags = new Map<string, string | boolean>([
    ['--allow-operation', input.operation], ['--accept-unknown-cost', true],
    ['--limit', String(input.bounds.limit)], ['--max-bytes', String(input.bounds.maxBytes)],
    ['--timeout', String(input.bounds.timeout)], ['--idle-timeout', String(input.bounds.idleTimeout)],
  ])
  if (input.selector.flag && input.selector.value) flags.set(input.selector.flag, input.selector.value)
  try {
    const path = resolve(dirname(toolPaths['shodan-axi']), '../dist/stream.js')
    const native = await import(pathToFileURL(path).href) as { streamDraft: (words: string[], flags: Map<string, string | boolean>) => { operation: string } }
    if (native.streamDraft(route.command.split(' '), flags).operation !== input.operation) throw new Error('Mismatched operation')
  } catch { throw new ArtiumError('INVALID_INPUT') }
  return [...route.command.split(' '), '--json', ...[...flags].flatMap(([flag, value]) => value === true ? [flag] : [flag, String(value)])]
}
