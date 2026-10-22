import type { z } from 'zod'
import type { toolWriteStateSchema, writeAccessInputSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'

type Settings = Record<string, unknown>
type WriteState = z.infer<typeof toolWriteStateSchema>
type WriteUpdate = z.infer<typeof writeAccessInputSchema>

// Adapters own the native shape and capability boundary; callers only see normalized state.
export function writePolicy(options: {
  reason?: string, supportedOperations?: readonly string[], unlocks: string, blocked: string,
}) {
  const supportedOperations = options.supportedOperations
  function read(settings: Settings): WriteState {
    const writes = settings.writes as { allowWrites?: boolean, operations?: string[] } | undefined
    return { capable: !options.reason, enabled: !options.reason && (supportedOperations ? writes?.allowWrites : settings.allowWrites) === true,
      reason: options.reason ?? null, supportedOperations: supportedOperations ? [...supportedOperations] : null,
      allowedOperations: supportedOperations ? [...writes?.operations ?? []] : [], unlocks: options.unlocks, blocked: options.blocked }
  }
  return { read, update(settings: Settings, input: WriteUpdate): Settings {
    if (options.reason) throw new ArtiumError('INVALID_INPUT', options.reason)
    if (!supportedOperations) {
      if (input.operations !== undefined) throw new ArtiumError('INVALID_INPUT', 'This tool does not use an operations allow-list.')
      return { ...settings, allowWrites: input.enabled }
    }
    const operations = input.operations ?? read(settings).allowedOperations
    if ((input.enabled || input.operations !== undefined) && operations.some(operation => !supportedOperations.includes(operation))) {
      throw new ArtiumError('INVALID_INPUT', 'The allow-list contains an operation this tool does not support.')
    }
    if (!operations.length) {
      if (input.enabled) throw new ArtiumError('INVALID_INPUT', 'Select at least one supported write operation.')
      const { writes: _, ...rest } = settings
      return rest
    }
    return { ...settings, writes: { ...settings.writes as Settings, allowWrites: input.enabled, operations } }
  } }
}
