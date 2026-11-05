import { z } from 'zod'

const positive = (maximum: number) => z.number().int().min(1).max(maximum)
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
