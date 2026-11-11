import { z } from 'zod'

const positive = (maximum: number) => z.number().int().min(1).max(maximum)
export const shodanScanPolicy = z.strictObject({
  grants: z.record(z.string().min(1).max(128), z.array(z.string().regex(/^OP-\d{3}$/)).max(32)),
  maxScanCredits: positive(1000000), maxRequests: positive(1000),
})
export const shodanQueryPolicy = z.strictObject({ maxQueryCredits: positive(1000) })
const operationGrants = (pattern: RegExp) => z.record(z.string().min(1).max(128), z.array(z.string().regex(pattern)).max(32))
export const shodanWritePolicy = z.strictObject({
  grants: operationGrants(/^OP-(013|015|016|019|020|021|022|023|024|027|028|030|037|038|070)$/),
  maxQueryCredits: positive(1000), maxRequests: positive(1000),
})
export const shodanExportPolicy = z.strictObject({
  grants: operationGrants(/^CLI-(005|020)$/),
  maxQueryCredits: positive(1000), maxRequests: positive(1000),
  maxRecords: positive(1000000), maxBytes: positive(1024 * 1024 * 1024), retentionSeconds: positive(86400),
})
export const shodanScanInput = z.strictObject({
  scope: z.strictObject({ kind: z.literal('targets'), targets: z.string().min(1).max(4096), force: z.boolean().default(false) }),
  waitSeconds: z.number().int().min(0).max(3600), limit: positive(10000), maxBytes: positive(1024 * 1024), idleTimeout: positive(3600000),
  scanCreditBudget: positive(1000000), maxRequests: positive(1000),
  acceptUnknownCost: z.boolean().default(false),
})
export const shodanWriteCommands = ['alert create', 'alert remove', 'alert update', 'alert enable', 'alert disable', 'alert ignore', 'alert unignore',
  'alert notifier add', 'alert notifier remove', 'notifier create', 'notifier remove', 'notifier update', 'org add', 'org remove'] as const
const notFlag = (value: string) => !value.startsWith('-')
export const shodanWriteInput = z.strictObject({
  command: z.enum(shodanWriteCommands),
  arguments: z.array(z.string().min(1).max(4096).refine(notFlag)).max(3).default([]),
  queryCreditBudget: positive(1000), maxRequests: positive(1000),
  expires: z.number().int().min(0).max(31536000).optional(),
  vulns: z.string().min(1).max(4096).refine(notFlag).optional(),
  silent: z.boolean().optional(),
  body: z.strictObject({
    provider: z.string().min(1).max(256).optional(), description: z.string().max(4096).optional(),
    args: z.record(z.string().min(1).max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))
      .refine(args => Object.keys(args).length <= 32),
  }).optional(),
})
const exportBounds = {
  fields: z.array(z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)).max(64).default([]),
  limit: positive(1000000), maxBytes: positive(1024 * 1024 * 1024), queryCreditBudget: positive(1000), maxRequests: positive(1000),
}
export const shodanExportInput = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('download'), query: z.string().min(1).max(4096), ...exportBounds }),
  z.strictObject({ command: z.literal('alert download'), alertId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), ...exportBounds }),
])
export const shodanStreamPolicy = z.strictObject({
  grants: z.record(z.string().min(1).max(128), z.array(z.string().regex(/^OP-\d{3}$/)).max(32)),
  perUser: positive(100), perCredential: positive(100), total: positive(1000),
  sessionEvents: positive(100000), totalEvents: positive(1000000),
  sessionBytes: positive(100 * 1024 * 1024), totalBytes: positive(1024 * 1024 * 1024),
  retentionSeconds: positive(86400), leaseSeconds: positive(3600),
})
export const shodanStreamBounds = z.strictObject({
  events: positive(100000).optional(), bytes: positive(100 * 1024 * 1024).optional(),
  retentionSeconds: positive(86400).optional(), leaseSeconds: positive(3600).optional(),
}).default({})
export const shodanWorkerBounds = z.strictObject({ limit: positive(10000), maxBytes: positive(1024 * 1024),
  timeout: positive(3600000), idleTimeout: positive(3600000) })
export const shodanStreamSelector = z.strictObject({ flag: z.string().regex(/^--[a-z][a-z-]*$/).optional(),
  value: z.string().min(1).max(2048).optional() }).refine(value => (value.flag === undefined) === (value.value === undefined))
export const shodanStreamStart = z.strictObject({ operation: z.string().regex(/^OP-\d{3}$/),
  selector: shodanStreamSelector, bounds: shodanWorkerBounds, limits: shodanStreamBounds,
  acceptUnknownCost: z.literal(true) })
export const shodanStreamRead = z.strictObject({ continuation: z.string().min(1).max(256).optional(), limit: positive(1000).default(100),
  waitMs: z.number().int().min(0).max(30000).default(0) })
export const shodanStreamExtendPreview = z.strictObject({ seconds: positive(3600) })
export const shodanStreamConfirm = z.strictObject({ confirm: z.uuid() })
