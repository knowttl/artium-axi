import { z } from 'zod'

export const mutationReceiptSchema = z.object({
  auditId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  operation: z.string().regex(/^OP-\d{3}(?:\.import)?$/),
  status: z.enum(['ok', 'partial', 'reconciled', 'revoke-failed']),
  credential: z.literal('consumed').optional(),
  mutation: z.literal('suppressed').optional(),
  revoked: z.boolean().optional(),
  localRemoved: z.boolean().optional(),
  journal: z.object({
    digest: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.[a-f0-9]{64}$/),
    state: z.enum(['completed', 'partial', 'reconciled', 'revoke-failed']),
    postconditionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    resyncSerial: z.number().int().nonnegative().optional(),
  }).readonly().optional(),
  cluster: z.object({
    scope: z.enum(['selected node', 'named node via vendor proxy']),
    completion: z.enum(['scheduled, not synchronized', 'selected-node state only']),
    effects: z.enum([
      'Initialize the selected node as primary; TLS listeners and identity may change',
      'Delete selected primary cluster configuration; remote nodes are not reset',
      'Add secondary membership and notify replicated configuration',
      'Ask the selected secondary to leave; remote completion requires a separate trusted read',
      'Delete primary membership only; the removed secondary is not reset',
      'Replace selected secondary address and certificate; notify replicated configuration',
      'Change cluster timers; omitted timers remain unchanged',
      'Join selected node as secondary and replace replicated configuration; TLS identity may change',
      'Leave selected secondary; force can leave stale primary membership',
      'Update primary identity and schedule configuration synchronization',
      'Trigger asynchronous configuration and cluster secondary zone resync',
      'Update primary address on selected secondary; replacement origin is not automatically trusted',
      'Promote selected secondary and remove old primary membership; force skips old primary synchronization and deletion',
      'Update selected node addresses; TLS trust remains unchanged',
    ]),
    uncertainty: z.literal('Remote nodes may retain cluster configuration; verify them with explicit trusted profiles').optional(),
  }).readonly().optional(),
}).readonly()

export type MutationReceipt = z.infer<typeof mutationReceiptSchema>

export const completedMutationSchema = z.strictObject({
  receipt: mutationReceiptSchema,
  exitCode: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  outputBytes: z.strictObject({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() }).readonly(),
  truncated: z.strictObject({ stdout: z.boolean(), stderr: z.boolean() }).readonly(),
}).readonly()

export type CompletedMutation = z.infer<typeof completedMutationSchema>
