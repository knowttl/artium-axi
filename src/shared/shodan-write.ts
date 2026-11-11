import { z } from 'zod'

export const shodanWriteBodyLimit = 1024 * 1024
export const shodanBulkWriteDeadlineMs = 8 * 60 * 60 * 1000 + 30 * 60 * 1000
export const shodanBulkWriteCommands = ['alert clear', 'alert domain', 'alert import'] as const

export const shodanWriteCommands = {
  'alert create': { positional: 2, grants: ['OP-013'], flags: ['--expires'] },
  'alert update': { positional: 2, grants: ['OP-016'], flags: [] },
  'alert remove': { positional: 1, grants: ['OP-015'], flags: [] },
  'alert enable': { positional: 2, grants: ['OP-019'], flags: [] },
  'alert disable': { positional: 2, grants: ['OP-020'], flags: [] },
  'alert ignore': { positional: 3, grants: ['OP-021'], flags: ['--vulns'] },
  'alert unignore': { positional: 3, grants: ['OP-022'], flags: [] },
  'alert notifier add': { positional: 2, grants: ['OP-023'], flags: [] },
  'alert notifier remove': { positional: 2, grants: ['OP-024'], flags: [] },
  'notifier create': { positional: 0, grants: ['OP-027'], flags: ['--body-file'] },
  'notifier update': { positional: 1, grants: ['OP-030'], flags: ['--body-file'] },
  'notifier remove': { positional: 1, grants: ['OP-028'], flags: [] },
  'org add': { positional: 1, grants: ['OP-037'], flags: ['--silent'] },
  'org remove': { positional: 1, grants: ['OP-038'], flags: [] },
  'alert clear': { positional: 0, grants: ['OP-015'], flags: [] },
  'alert domain': { positional: 1, grants: ['OP-013', 'OP-019', 'OP-040'], flags: ['--triggers'] },
  'alert import': { positional: 1, grants: ['OP-013', 'OP-019', 'OP-021', 'OP-023', 'OP-027'], flags: [] },
} as const

export type ShodanWriteCommand = keyof typeof shodanWriteCommands

export const shodanWriteEffect = z.object({
  operation: z.string(), method: z.string(), target: z.string(), networks: z.array(z.string()).optional(),
  notify: z.boolean().optional(), downgrade: z.boolean().optional(),
}).passthrough()

export const shodanWritePreview = z.object({
  confirm: z.uuid(), instance: z.string().min(1), command: z.enum(Object.keys(shodanWriteCommands) as [ShodanWriteCommand, ...ShodanWriteCommand[]]),
  operation: z.string().min(1), effects: z.array(shodanWriteEffect), queryCreditBudget: z.number().int().positive(),
  maxRequests: z.number().int().positive(), cost: z.literal('unknown'), expiresAt: z.number().int().nonnegative(),
}).passthrough()

const shodanWriteStep = z.object({ operation: z.string(), target: z.string(),
  status: z.enum(['verified', 'acknowledged-unverified', 'failed', 'not-attempted']) }).passthrough()
export const shodanWriteOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), steps: z.array(shodanWriteStep) }).passthrough(),
  z.object({ status: z.literal('OUTCOME_UNKNOWN'), completed: z.array(shodanWriteStep), uncertain: shodanWriteStep,
    unsent: z.array(shodanWriteStep), steps: z.array(shodanWriteStep) }).passthrough(),
  z.object({ status: z.literal('READBACK_UNVERIFIED'), completed: z.array(shodanWriteStep),
    unsent: z.array(shodanWriteStep), steps: z.array(shodanWriteStep) }).passthrough(),
])

export const shodanNotifierBody = z.strictObject({
  provider: z.string().min(1).optional(), description: z.string().optional(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).refine(args => Object.keys(args).length > 0),
})
