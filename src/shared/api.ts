import { z } from 'zod'
import { errors } from './errors.js'

export const inputLimits = {
  requestBytes: 16 * 1024 * 1024,
  arguments: 64,
  argumentBytes: 4096,
  stdinBytes: 512 * 1024,
  fileBytes: 1024 * 1024,
  totalFileBytes: 4 * 1024 * 1024,
  files: 8,
} as const

const byteLength = (value: string) => new TextEncoder().encode(value).length
export const passwordSchema = z.string().refine(value => {
  const length = [...value].length
  return length >= 15 && length <= 128 && byteLength(value) <= 512
}, 'Expected 15 to 128 Unicode code points and at most 512 UTF-8 bytes')
export const passwordChangeSchema = z.strictObject({ newPassword: z.string(), currentPassword: z.string().optional() })
export const loginSchema = z.strictObject({ username: z.string(), password: z.string() })
export const refreshSchema = z.strictObject({ refreshToken: z.string().min(1) })
export const reauthSchema = z.strictObject({ password: z.string() })
export const reauthResponseSchema = z.strictObject({ ticket: z.string(), expiresAt: z.number().int() })
export const loginResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('authenticated'), accessToken: z.string(), refreshToken: z.string(),
    accessExpiresAt: z.number().int(), familyExpiresAt: z.number().int() }),
  z.strictObject({ status: z.literal('password-change-required'), passwordChangeToken: z.string(),
    passwordChangeExpiresAt: z.number().int() }),
])
export type LoginResponse = z.infer<typeof loginResponseSchema>
const accountId = z.string().min(1)
export const adminUserSchema = z.strictObject({
  id: accountId, username: z.string(), displayName: z.string(), source: z.literal('local'),
  enabled: z.boolean(), administrator: z.boolean(), mustChange: z.boolean(),
  failedAttempts: z.number().int().nonnegative(), lockedUntil: z.number().int().nullable(),
  revision: z.number().int().positive(), updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable(),
  roleIds: z.array(accountId),
})
export const adminUsersQuerySchema = z.strictObject({ cursor: accountId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
export const adminUsersResponseSchema = z.strictObject({ users: z.array(adminUserSchema), nextCursor: accountId.nullable() })
export const adminUserCreateSchema = z.strictObject({ username: z.string().min(1), displayName: z.string().min(1),
  temporaryPassword: z.string(), administrator: z.boolean(), roleIds: z.array(accountId).refine(ids => new Set(ids).size === ids.length) })
export const adminUserPatchSchema = z.strictObject({ displayName: z.string().min(1).optional(), enabled: z.boolean().optional(),
  administrator: z.boolean().optional(), expectedRevision: z.number().int().positive() })
  .refine(input => input.displayName !== undefined || input.enabled !== undefined || input.administrator !== undefined)
export const adminUserUnlockSchema = z.strictObject({})
export const adminUserResetSchema = z.strictObject({ temporaryPassword: z.string() })
export const adminUserParamsSchema = z.strictObject({ id: accountId })

// Bearer administration requires both the current capability and a session-bound password ticket.
export const adminUserRoutes = {
  list: { method: 'GET', path: '/v1/admin/users', input: adminUsersQuerySchema, response: adminUsersResponseSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: null },
  create: { method: 'POST', path: '/v1/admin/users', input: adminUserCreateSchema, response: adminUserSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'create-user' },
  patch: { method: 'PATCH', path: '/v1/admin/users/:id', input: adminUserPatchSchema, response: adminUserSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'update-user' },
  unlock: { method: 'POST', path: '/v1/admin/users/:id/unlock', input: adminUserUnlockSchema, response: adminUserSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'unlock-user' },
  reset: { method: 'POST', path: '/v1/admin/users/:id/password-reset', input: adminUserResetSchema, response: adminUserSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'reset-user-password' },
  roles: { method: 'PUT', path: '/v1/admin/users/:id/roles',
    input: z.strictObject({ roleIds: z.array(accountId).refine(ids => new Set(ids).size === ids.length), expectedRevision: z.number().int().positive() }),
    response: adminUserSchema, authorization: 'administrator-and-recent-auth', auditEvent: 'assign-user-roles' },
} as const
const text = z.string().refine(value => !value.includes('\0'), 'NUL is not allowed')
export const toolSchema = z.enum(['falcon-axi', 'vectra-axi', 'az-axi'])
export const adminRoleSchema = z.strictObject({ id: accountId, name: z.string().min(1), tools: z.array(toolSchema),
  revision: z.number().int().positive(), updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable() })
export const adminRolesResponseSchema = z.strictObject({ roles: z.array(adminRoleSchema), nextCursor: accountId.nullable() })
export const adminRoleRoutes = {
  list: { method: 'GET', path: '/v1/admin/roles', input: adminUsersQuerySchema, response: adminRolesResponseSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: null },
  create: { method: 'POST', path: '/v1/admin/roles', input: z.strictObject({ name: z.string().min(1) }), response: adminRoleSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'create-role' },
  patch: { method: 'PATCH', path: '/v1/admin/roles/:id',
    input: z.strictObject({ name: z.string().min(1), expectedRevision: z.number().int().positive() }), response: adminRoleSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'rename-role' },
  tools: { method: 'PUT', path: '/v1/admin/roles/:id/tools',
    input: z.strictObject({ tools: z.array(toolSchema).refine(tools => new Set(tools).size === tools.length), expectedRevision: z.number().int().positive() }),
    response: adminRoleSchema, authorization: 'administrator-and-recent-auth', auditEvent: 'replace-role-tools' },
} as const
export const toolsResponseSchema = z.strictObject({
  tools: z.array(z.strictObject({
    name: toolSchema,
    version: z.string(),
    status: z.enum(['unconfigured', 'unknown', 'ok', 'error', 'disabled']),
  })),
})
export const inputFileSchema = z.strictObject({
  name: text.min(1).refine(value => value !== '.' && value !== '..' && !/[\\/:\x00-\x1f\x7f]/.test(value) && byteLength(value) <= 255, 'Expected a safe leaf name'),
  contentBase64: z.string().max(4 * Math.ceil(inputLimits.fileBytes / 3))
    .refine(value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Expected canonical base64')
    .refine(value => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      if (value.endsWith('==')) return alphabet.indexOf(value.at(-3)!) % 16 === 0
      if (value.endsWith('=')) return alphabet.indexOf(value.at(-2)!) % 4 === 0
      return true
    }, 'Expected canonical base64')
    .refine(value => decodedFileBytes(value) <= inputLimits.fileBytes, 'File exceeds byte limit'),
})

export function decodedFileBytes(value: string): number {
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}

export const runInputSchema = z.strictObject({
  stdin: text.refine(value => byteLength(value) <= inputLimits.stdinBytes, 'Stdin exceeds byte limit').optional(),
  files: z.array(inputFileSchema).max(inputLimits.files).refine(files =>
    new Set(files.map(file => file.name)).size === files.length &&
    files.reduce((total, file) => total + decodedFileBytes(file.contentBase64), 0) <= inputLimits.totalFileBytes,
  'Duplicate names or total file byte limit exceeded').optional(),
})

export const runRequestSchema = runInputSchema.extend({
  args: z.array(text.refine(value => byteLength(value) <= inputLimits.argumentBytes, 'Argument exceeds byte limit')).max(inputLimits.arguments),
})

const counts = z.strictObject({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() })
export const runSuccessSchema = z.strictObject({
  source: toolSchema,
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  outputBytes: counts,
  truncated: z.strictObject({ stdout: z.boolean(), stderr: z.boolean() }),
})
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(Object.keys(errors) as [keyof typeof errors, ...(keyof typeof errors)[]]),
    source: z.literal('artium-axi'),
    message: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)),
    next: z.string().min(1),
    requestId: z.string().min(1),
  }),
})
export const runResponseSchema = z.union([runSuccessSchema, errorResponseSchema])
export type InputFile = z.infer<typeof inputFileSchema>
export type RunInput = z.infer<typeof runInputSchema>
export type RunRequest = z.infer<typeof runRequestSchema>
export type RunSuccess = z.infer<typeof runSuccessSchema>
export type RunResponse = z.infer<typeof runResponseSchema>
