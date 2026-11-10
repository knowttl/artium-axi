import { expect, test } from 'vitest'
import { nativeSettingsSchemas } from './api.js'

const schema = nativeSettingsSchemas['shodan-axi']
const writes = { grants: { 'synthetic-user': ['OP-013'] }, maxQueryCredits: 10, maxRequests: 20 }
const exports = { grants: { 'synthetic-user': ['CLI-005', 'CLI-020'] }, maxQueryCredits: 10, maxRequests: 20, maxRecords: 1000, maxBytes: 1024, retentionSeconds: 60 }

test('writes and exports are separate optional settings blocks', () => {
  expect(schema.parse({ writes })).toEqual({ writes })
  expect(schema.parse({ exports })).toEqual({ exports })
  expect(schema.parse({ writes, exports })).toEqual({ writes, exports })
})

test('all reviewed write operation IDs are accepted', () => {
  const reviewed = ['OP-013', 'OP-015', 'OP-016', 'OP-019', 'OP-020', 'OP-021', 'OP-022', 'OP-023', 'OP-024', 'OP-027', 'OP-028', 'OP-030', 'OP-037', 'OP-038', 'OP-070']
  expect(schema.parse({ writes: { ...writes, grants: { 'synthetic-user': reviewed } } }).writes?.grants['synthetic-user']).toEqual(reviewed)
})

test.each([
  ['an unreviewed operation grant in writes', { writes: { ...writes, grants: { 'synthetic-user': ['OP-003'] } } }],
  ['an export command grant in writes', { writes: { ...writes, grants: { 'synthetic-user': ['CLI-005'] } } }],
  ['an unreviewed command grant in exports', { exports: { ...exports, grants: { 'synthetic-user': ['CLI-025'] } } }],
  ['a write operation grant in exports', { exports: { ...exports, grants: { 'synthetic-user': ['OP-013'] } } }],
  ['a write credit ceiling above the upstream ceiling', { writes: { ...writes, maxQueryCredits: 1001 } }],
  ['a write request ceiling of zero', { writes: { ...writes, maxRequests: 0 } }],
  ['an export request ceiling above the upstream ceiling', { exports: { ...exports, maxRequests: 1001 } }],
  ['an export record ceiling above the native limit', { exports: { ...exports, maxRecords: 1000001 } }],
  ['an export byte ceiling above the native limit', { exports: { ...exports, maxBytes: 1024 ** 3 + 1 } }],
  ['an export retention above one day', { exports: { ...exports, retentionSeconds: 86401 } }],
  ['an export block without retention', { exports: { grants: exports.grants, maxQueryCredits: 10, maxRequests: 20, maxRecords: 1000, maxBytes: 1024 } }],
  ['an unknown writes field', { writes: { ...writes, maxBytes: 1 } }],
])('%s is refused', (_name, settings) => {
  expect(schema.safeParse(settings).success).toBe(false)
})
