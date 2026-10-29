import { expect, test } from 'vitest'
import { errorDiagnostic } from '../src/server/error-diagnostic.js'

test('diagnostics bound frames and exclude messages, function names and paths outside application code', () => {
  const error = Object.assign(new Error('CANARY-message'), { code: 'ERR_SYNTHETIC' })
  error.stack = `Error: CANARY-message\n    at CANARY-function (${process.cwd()}/dist/src/server/app.js:3:8)\n    at /private/CANARY.js:2:8\n` +
    Array.from({ length: 8 }, (_, index) => `    at file://${process.cwd()}/node_modules/package/index.js:${index + 10}:9`).join('\n')
  expect(errorDiagnostic(error)).toEqual({ errorCode: 'ERR_SYNTHETIC', frames: [
    'dist/src/server/app.js:3', 'node_modules/package/index.js:10', 'node_modules/package/index.js:11',
    'node_modules/package/index.js:12', 'node_modules/package/index.js:13',
  ] })
  expect(JSON.stringify(errorDiagnostic(error))).not.toContain('CANARY')
})

test.each(['CANARY-secret', 'ENOENT\nCANARY-secret', 'E' + 'A'.repeat(100)])('diagnostics omit unsafe code %s', code => {
  const error = Object.assign(new Error('CANARY-message'), { code, stack: 'CANARY-stack' })
  expect(errorDiagnostic(error)).toEqual({})
})
