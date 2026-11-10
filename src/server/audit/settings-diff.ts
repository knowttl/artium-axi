import { z } from 'zod'

export const settingChangeSchema = z.union([
  z.strictObject({ path: z.array(z.string()), before: z.json(), after: z.json() }),
  z.strictObject({ path: z.array(z.string()), added: z.array(z.json()), removed: z.array(z.json()) }),
])
export type SettingChange = z.infer<typeof settingChangeSchema>
export const settingsChangesArgumentsSchema = z.strictObject({ settings: z.array(settingChangeSchema) })

type Json = z.infer<ReturnType<typeof z.json>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const shapeOf = (value: unknown) => value === undefined ? 'absent' : Array.isArray(value) ? 'list' : isRecord(value) ? 'object' : 'value'

export function diffSettings(before: unknown, after: unknown, path: string[] = []): SettingChange[] {
  if (path.at(-1) === 'operations' && ['writes', 'hostWrites'].includes(path.at(-2) ?? '')) return []
  const [from, to] = [shapeOf(before), shapeOf(after)]
  const shape = from === 'absent' ? to : to === 'absent' || from === to ? from : 'value'
  if (shape === 'object') {
    const left = isRecord(before) ? before : {}
    const right = isRecord(after) ? after : {}
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      .flatMap(key => diffSettings(left[key], right[key], [...path, key]))
  }
  if (shape === 'list') {
    const left = (Array.isArray(before) ? before : []) as Json[]
    const right = (Array.isArray(after) ? after : []) as Json[]
    const only = (items: Json[], other: Json[]) => {
      const kept = new Set(other.map(item => JSON.stringify(item)))
      return items.filter(item => !kept.has(JSON.stringify(item)))
    }
    const added = only(right, left)
    const removed = only(left, right)
    return added.length || removed.length ? [{ path, added, removed }] : []
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  return [{ path, before: (before ?? null) as Json, after: (after ?? null) as Json }]
}
