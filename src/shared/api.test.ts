import { expect, test } from 'vitest'
import { errorResponseSchema, inputLimits, runRequestSchema, runResponseSchema, toolSchema } from './api.js'
import { ArtiumError, errorResponse, errors } from './errors.js'

const file = (name: string, bytes = 0) => ({ name, contentBase64: Buffer.alloc(bytes).toString('base64') })

test('accepts the exact argument and UTF-8 stdin byte limits', () => {
  expect(runRequestSchema.parse({ args: Array(64).fill('é'.repeat(2048)), stdin: 'é'.repeat(inputLimits.stdinBytes / 2) }).args).toHaveLength(64)
})

test.each([
  { args: Array(65).fill('') },
  { args: ['é'.repeat(2048) + 'a'] },
  { args: ['a\0b'] },
  { args: [], stdin: 'é'.repeat(inputLimits.stdinBytes / 2) + 'a' },
  { args: [], stdin: '\0' },
  { args: [], environment: {} },
  { args: [], executable: '/synthetic/tool' },
  { args: [], cwd: '/synthetic' },
  { args: [], timeout: 1 },
  { args: [], credential: 'CANARY' },
  { args: [], files: [{ ...file('a'), path: '/synthetic/file' }] },
])('rejects invalid request limits and unknown fields: %j', body => {
  expect(runRequestSchema.safeParse(body).success).toBe(false)
})

test('accepts the exact per-file, aggregate and count limits', () => {
  expect(runRequestSchema.safeParse({ args: [], files: Array.from({ length: 4 }, (_, index) => file(String(index), inputLimits.fileBytes)) }).success).toBe(true)
  expect(runRequestSchema.safeParse({ args: [], files: Array.from({ length: 8 }, (_, index) => file(String(index))) }).success).toBe(true)
})

test.each([
  { files: [file('a', inputLimits.fileBytes + 1)] },
  { files: [file('a'), file('a')] },
  { files: Array.from({ length: 9 }, (_, index) => file(String(index))) },
  { files: [...Array.from({ length: 4 }, (_, index) => file(String(index), inputLimits.fileBytes)), file('extra', 1)] },
])('rejects excessive or duplicate uploads', ({ files }) => {
  expect(runRequestSchema.safeParse({ args: [], files }).success).toBe(false)
})

test.each(['', '.', '..', '../file', '/file', 'a/b', 'a\\b', 'C:drive', 'a\0b', 'a\nb', 'é'.repeat(128)])('security rejects unsafe upload name %j', name => {
  expect(runRequestSchema.safeParse({ args: [], files: [file(name)] }).success).toBe(false)
})

test.each(['YQ', 'YQ=', 'YQ===', 'Y Q==', 'YQ==\n', '_w==', '!!!!', 'YR==', 'YWJ='])('rejects malformed base64 %j', contentBase64 => {
  expect(runRequestSchema.safeParse({ args: [], files: [{ name: 'file', contentBase64 }] }).success).toBe(false)
})

test.each(['', 'YQ==', 'YWI=', 'YWJj', '/w=='])('accepts canonical base64 %j', contentBase64 => {
  expect(runRequestSchema.safeParse({ args: [], files: [{ name: 'file', contentBase64 }] }).success).toBe(true)
})

test('response contract preserves upstream failure and rejects mixed envelopes', () => {
  const success = { source: 'falcon-axi', stdout: 'safe', stderr: 'usage', exitCode: 2, durationMs: 1.5, outputBytes: { stdout: 4, stderr: 5 }, truncated: { stdout: false, stderr: false } }
  expect(runResponseSchema.parse(success)).toEqual(success)
  expect(runResponseSchema.safeParse({ ...success, timedOut: false }).success).toBe(false)
  expect(runResponseSchema.safeParse({ ...success, ...errorResponse(new ArtiumError('TIMEOUT'), 'synthetic-request') }).success).toBe(false)
  expect(toolSchema.safeParse('/synthetic/executable').success).toBe(false)
  expect(toolSchema.safeParse('mg-axi').success).toBe(false)
})

test.each(Object.keys(errors) as (keyof typeof errors)[])('catalogue produces a strict safe envelope for %s', code => {
  const response = errorResponse(new ArtiumError(code), 'synthetic-request')
  expect(errorResponseSchema.parse(response)).toEqual({ error: { code, source: 'artium-axi', message: errors[code].message, next: errors[code].next, requestId: 'synthetic-request' } })
})

test.each([['INVALID_INPUT', 400], ['UNSUPPORTED_INPUT', 400], ['TOO_MANY_CALLS', 429], ['TIMEOUT', 504], ['SECRET_IN_OUTPUT', 500], ['TEMP_UNAVAILABLE', 503]] as const)('maps %s to HTTP %i', (code, status) => {
  expect(errors[code].status).toBe(status)
})
