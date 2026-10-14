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
// Bearer callers receive a session-family ticket; cookie callers require same-origin CSRF
// proof and receive 204 after updating their browser session's password-confirmation time.
// Cookie responses include x-artium-reauth-until as Unix milliseconds for the browser header.
// Browser API calls requesting application/json receive REAUTH_REQUIRED as JSON;
// ordinary page/form requests retain the /reauth redirect.
export const reauthResponseSchema = z.strictObject({ ticket: z.string(), expiresAt: z.number().int() })
export const loginResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('authenticated'), accessToken: z.string(), refreshToken: z.string(),
    accessExpiresAt: z.number().int(), familyExpiresAt: z.number().int() }),
  z.strictObject({ status: z.literal('password-change-required'), passwordChangeToken: z.string(),
    passwordChangeExpiresAt: z.number().int() }),
])
export type LoginResponse = z.infer<typeof loginResponseSchema>
export const meResponseSchema = z.strictObject({ username: z.string(), displayName: z.string(),
  administrator: z.boolean(), roles: z.array(z.string()), accessExpiresAt: z.number().int() })
const accountId = z.string().min(1)
export const toolSchema = z.enum(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi', 'ldap-axi'])
export const adminUserSchema = z.strictObject({
  id: accountId, username: z.string(), displayName: z.string(), source: z.literal('local'),
  enabled: z.boolean(), administrator: z.boolean(), mustChange: z.boolean(),
  failedAttempts: z.number().int().nonnegative(), lockedUntil: z.number().int().nullable(),
  revision: z.number().int().positive(), updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable(),
  roleIds: z.array(accountId),
})
const adminPageQuerySchema = z.strictObject({ cursor: accountId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
export const adminUsersQuerySchema = adminPageQuerySchema.extend({
  q: z.string().min(1).max(256).optional(), source: z.literal('local').optional(),
  status: z.enum(['enabled', 'disabled']).optional(), role: accountId.optional(),
})
// totalCount counts all matching users, independent of cursor; pagination keeps the same filters.
export const adminUsersResponseSchema = z.strictObject({ users: z.array(adminUserSchema), nextCursor: accountId.nullable(),
  totalCount: z.number().int().nonnegative() })
// Grants are deduplicated by tool; enabled requires both an enabled user and enabled tool.
export const adminUserDetailSchema = adminUserSchema.extend({ effectiveTools: z.array(z.strictObject({
  name: toolSchema, enabled: z.boolean(), roleIds: z.array(accountId),
})) })
export const adminUserCreateSchema = z.strictObject({ username: z.string().min(1), displayName: z.string().min(1),
  temporaryPassword: z.string(), administrator: z.boolean(), roleIds: z.array(accountId).refine(ids => new Set(ids).size === ids.length) })
export const adminUserPatchSchema = z.strictObject({ displayName: z.string().min(1).optional(), enabled: z.boolean().optional(),
  administrator: z.boolean().optional(), expectedRevision: z.number().int().positive() })
  .refine(input => input.displayName !== undefined || input.enabled !== undefined || input.administrator !== undefined)
export const adminUserUnlockSchema = z.strictObject({})
export const adminUserResetSchema = z.strictObject({ temporaryPassword: z.string() })
export const adminUserParamsSchema = z.strictObject({ id: accountId })

// Bearer administration requires both the current capability and a session-bound password ticket.
// Cookie administration requires the current capability, with recent password confirmation
// and same-origin CSRF proof on mutations; GET and HEAD do not require recent confirmation.
export const adminUserRoutes = {
  list: { method: 'GET', path: '/v1/admin/users', input: adminUsersQuerySchema, response: adminUsersResponseSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: null },
  get: { method: 'GET', path: '/v1/admin/users/:id', input: z.strictObject({}), response: adminUserDetailSchema,
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
// The ceiling excludes inserts after the first page, including backdated events.
const auditCursorSchema = z.string().max(50).regex(/^\d{1,16}:\d{1,16}:\d{1,16}$/)
  .refine(value => {
    const [ceiling, time, id] = value.split(':').map(Number) as [number, number, number]
    return [ceiling, time, id].every(Number.isSafeInteger) && ceiling > 0 && id > 0 && id <= ceiling && time <= 8_640_000_000_000_000
  })
export const adminAuditQuerySchema = z.strictObject({
  cursor: auditCursorSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  user: z.string().min(1).max(256).optional(), tool: toolSchema.optional(),
  outcome: z.string().min(1).max(100).optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
}).refine(input => !input.from || !input.to || Date.parse(input.from) <= Date.parse(input.to))
export const adminAuditRecordSchema = z.strictObject({
  id: z.number().int().positive(), occurred_at: z.number().int(), event: z.string(), user_id: z.string().nullable(),
  tool: toolSchema.nullable(), arguments: z.string().nullable(), request_id: z.string(),
  exit_code: z.number().int().nullable(), duration_ms: z.number().int().nullable(),
  stdout_bytes: z.number().int().nullable(), stderr_bytes: z.number().int().nullable(),
  client_address: z.string().nullable(), outcome: z.string(), action: z.string().nullable(), target_id: z.string().nullable(),
  cutoff: z.number().int().nullable(), deleted_count: z.number().int().nullable(), checked_at: z.number().int().nullable(),
  credential_revision: z.number().int().nullable(), error_code: z.string().nullable(),
})
export const adminAuditRoute = { method: 'GET', path: '/v1/admin/audit', input: adminAuditQuerySchema,
  response: z.strictObject({ records: z.array(adminAuditRecordSchema).max(100), nextCursor: auditCursorSchema.nullable() }),
  authorization: 'administrator-and-recent-auth', auditEvent: null } as const
export const nativeSettingsSchemas = {
  'ldap-axi': z.strictObject({}),
  'mg-axi': z.strictObject({ preview: z.boolean().optional(), writes: z.strictObject({ allowWrites: z.boolean(),
    operations: z.array(z.string().min(1).max(256)).min(1).max(64) }).optional() }),
  'falcon-axi': z.strictObject({}),
  'vectra-axi': z.strictObject({ writes: z.strictObject({ allowWrites: z.boolean(),
    operations: z.array(z.string().min(1).refine(value => value.trim().length > 0)).min(1) }).optional() }),
  'az-axi': z.strictObject({ subscriptions: z.array(z.string().min(1)).optional(),
    managementGroup: z.string().min(1).optional(), workspaces: z.record(z.string().min(1), z.uuid()).optional(),
    description: z.string().optional(), allowWrites: z.boolean().optional() }),
} as const
export const healthSchema = z.strictObject({ status: z.enum(['unconfigured', 'unknown', 'ok', 'error', 'disabled']),
  checkedAt: z.number().int().nullable(), credentialRevision: z.number().int().nullable(), errorCode: z.enum(Object.keys(errors) as [keyof typeof errors, ...Array<keyof typeof errors>]).nullable() })
// Tool versions in adminToolSchema and toolsResponseSchema identify the server's bundled inventory,
// independent of a retained store's pinned_version value.
export const adminToolSchema = z.strictObject({ name: toolSchema, enabled: z.boolean(), version: z.string(),
  nativeSettings: z.record(z.string(), z.unknown()), revision: z.number().int().positive(),
  updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable(), health: healthSchema })
export const adminCredentialSchema = z.strictObject({ tool: toolSchema, configured: z.boolean(),
  metadata: z.record(z.string(), z.unknown()), revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable() })
export const adminToolParamsSchema = z.strictObject({ tool: toolSchema })
export const adminToolRoutes = {
  list: { method: 'GET', path: '/v1/admin/tools', input: z.strictObject({}),
    response: z.strictObject({ tools: z.array(adminToolSchema) }), authorization: 'administrator-and-recent-auth', auditEvent: null },
  patch: { method: 'PATCH', path: '/v1/admin/tools/:tool',
    input: z.strictObject({ enabled: z.boolean().optional(), nativeSettings: z.record(z.string(), z.unknown()).optional(),
      expectedRevision: z.number().int().positive() }).refine(input => input.enabled !== undefined || input.nativeSettings !== undefined),
    response: adminToolSchema, authorization: 'administrator-and-recent-auth', auditEvent: 'update-tool' },
  credential: { method: 'GET', path: '/v1/admin/tools/:tool/credential', input: z.strictObject({}),
    response: adminCredentialSchema, authorization: 'administrator-and-recent-auth', auditEvent: null },
  replace: { method: 'PUT', path: '/v1/admin/tools/:tool/credential',
    input: z.strictObject({ value: z.unknown(), expectedRevision: z.number().int().nonnegative(),
      expectedToolRevision: z.number().int().positive() }),
    response: adminCredentialSchema, authorization: 'administrator-and-recent-auth', auditEvent: 'replace-credential' },
  test: { method: 'POST', path: '/v1/admin/tools/:tool/test', input: z.strictObject({}), response: healthSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: 'credential-test' },
} as const
export const adminRoleSchema = z.strictObject({ id: accountId, name: z.string().min(1), tools: z.array(toolSchema),
  revision: z.number().int().positive(), updatedAt: z.number().int().nullable(), updatedBy: accountId.nullable() })
export const adminRolesResponseSchema = z.strictObject({ roles: z.array(adminRoleSchema), nextCursor: accountId.nullable() })
export const adminRoleRoutes = {
  list: { method: 'GET', path: '/v1/admin/roles', input: adminPageQuerySchema, response: adminRolesResponseSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: null },
  get: { method: 'GET', path: '/v1/admin/roles/:id', input: z.strictObject({}), response: adminRoleSchema,
    authorization: 'administrator-and-recent-auth', auditEvent: null },
  members: { method: 'GET', path: '/v1/admin/roles/:id/members', input: adminPageQuerySchema,
    response: adminUsersResponseSchema, authorization: 'administrator-and-recent-auth', auditEvent: null },
  delete: { method: 'DELETE', path: '/v1/admin/roles/:id',
    input: z.strictObject({ expectedRevision: z.number().int().positive() }),
    response: z.strictObject({ id: accountId, deleted: z.literal(true) }),
    authorization: 'administrator-and-recent-auth', auditEvent: 'delete-role' },
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
