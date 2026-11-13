import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'
import { retestScript } from '../src/server/admin/retest.js'

const secret = 'CANARY-unlabelled-credential'
const quotedSecret = '"CANARY several secret words"'
const cases: { name: string, failure?: unknown, response?: unknown, kind: string, expected: string }[] = [
  ...[
    { stage: 'TCP', toolCode: 'EHOSTUNREACH' },
    { stage: 'TLS', toolCode: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' },
    { stage: 'token acquisition', providerCode: 'AADSTS7000222' },
    { stage: 'response', upstreamStatus: 503 },
  ].map(diagnostic => ({ name: JSON.stringify(diagnostic), kind: 'http',
    response: Response.json({ error: { code: 'TOOL_FAILED', diagnostic } }, { status: 503 }),
    expected: 'Connection test: HTTP 503. The tool exited unsuccessfully. (TOOL_FAILED). Failed step: ' + diagnostic.stage + '.' +
      (diagnostic.toolCode ? ' Transport: ' + diagnostic.toolCode + '.' : '') +
      (diagnostic.providerCode ? ' Provider: ' + diagnostic.providerCode + '.' : '') +
      (diagnostic.upstreamStatus ? ' Upstream HTTP ' + diagnostic.upstreamStatus + '.' : '') + ' Run Test connection again.' })),
  ...['long free text '.repeat(100), 'eyJhbGciOiJIUzI1NiJ9.payload.signature', 'CANARY-token-with-hyphens'].map(value => ({
    name: 'unsafe structured value ' + value.slice(0, 20), kind: 'http',
    response: Response.json({ error: { diagnostic: { toolCode: value, providerCode: value, upstreamStatus: value } } }, { status: 503 }),
    expected: 'Connection test: HTTP 503. Server error code unavailable. Run Test connection again.',
  })),
  ...[99, 600, 503.5, '503'].map(upstreamStatus => ({ name: 'invalid upstream status ' + upstreamStatus, kind: 'http',
    response: Response.json({ error: { diagnostic: { upstreamStatus } } }, { status: 503 }),
    expected: 'Connection test: HTTP 503. Server error code unavailable. Run Test connection again.',
  })),
  { name: 'localised network rejection', failure: new TypeError('Échec réseau ' + secret), kind: 'network',
    expected: 'Connection test: Could not reach the artium admin server (TypeError). Run Test connection again.' },
  { name: 'known network code', failure: Object.assign(new Error(quotedSecret), { cause: { code: 'ECONNREFUSED' } }), kind: 'network',
    expected: 'Connection test: Could not reach the artium admin server (ECONNREFUSED). Run Test connection again.' },
  { name: 'arbitrary exception fields', failure: { name: secret, code: quotedSecret, message: secret }, kind: 'network',
    expected: 'Connection test: Could not reach the artium admin server. Run Test connection again.' },
  { name: 'unlabelled credential in invalid JSON', response: new Response(secret), kind: 'json',
    expected: 'Connection test: response was not valid JSON. HTTP 200. Check the server or proxy response format. Run Test connection again.' },
  { name: 'quoted multi-word secret in invalid JSON', response: new Response('invalid ' + quotedSecret, { status: 502 }), kind: 'json',
    expected: 'Connection test: response was not valid JSON. HTTP 502. Check the server or proxy response format. Run Test connection again.' },
  { name: 'interrupted response', response: { status: 200, ok: true, json: async () => { throw new TypeError(secret) } }, kind: 'body',
    expected: 'Connection test: response body could not be read (TypeError). HTTP 200. Check the connection for an interrupted response. Run Test connection again.' },
  { name: 'invalid success shape', response: Response.json({ status: secret, message: quotedSecret }), kind: 'schema',
    expected: 'Connection test: response did not match the connection-test format. HTTP 200. Check server and client version compatibility. Run Test connection again.' },
  { name: 'non-OK response with untrusted fields', response: Response.json({ error: { code: secret, message: quotedSecret,
    diagnostic: { stage: secret, toolCode: secret, trust: quotedSecret } } }, { status: 403 }), kind: 'http',
    expected: 'Connection test: HTTP 403. Server error code unavailable. Run Test connection again.' },
  { name: 'TLS failure with structured fields', response: Response.json({ error: { code: 'UPSTREAM_TLS_FAILED', message: secret,
    diagnostic: { stage: 'TLS', toolCode: 'CERT_HAS_EXPIRED', trust: 'untrusted', message: quotedSecret, host: secret } } }, { status: 503 }), kind: 'http',
    expected: 'Connection test: HTTP 503. The upstream certificate could not be verified. (UPSTREAM_TLS_FAILED). Failed step: TLS. Transport: CERT_HAS_EXPIRED. Certificate trust: untrusted. Run Test connection again.' },
  { name: 'TCP refusal with structured fields', response: Response.json({ error: { code: 'UPSTREAM_NETWORK_FAILED',
    diagnostic: { stage: 'TCP', toolCode: 'ECONNREFUSED' } } }, { status: 503 }), kind: 'http',
    expected: 'Connection test: HTTP 503. The upstream service could not be reached. (UPSTREAM_NETWORK_FAILED). Failed step: TCP. Transport: ECONNREFUSED. Run Test connection again.' },
  { name: 'hostname mismatch with structured fields', response: Response.json({ error: { code: 'UPSTREAM_TLS_FAILED',
    diagnostic: { stage: 'TLS', toolCode: 'HOSTNAME_MISMATCH' } } }, { status: 503 }), kind: 'http',
    expected: 'Connection test: HTTP 503. The upstream certificate could not be verified. (UPSTREAM_TLS_FAILED). Failed step: TLS. Transport: HOSTNAME_MISMATCH. Run Test connection again.' },
]

test.each(cases)('retest shows only structured detail for $name', async ({ failure, response, expected, kind }) => {
  const messages: unknown[] = []
  const context = { fetch: async () => { if (failure) throw failure; return response },
    console: { log: (...args: unknown[]) => messages.push(args), error: (...args: unknown[]) => messages.push(args), warn: (...args: unknown[]) => messages.push(args) } }
  const result = await runInNewContext(retestScript + '; retestConnection("/test", "CANARY-csrf")', context)
  expect(result.diagnostic.kind).toBe(kind)
  expect(runInNewContext(retestScript + '; renderRetestDiagnostic(detail)', { detail: result.diagnostic })).toBe(expected)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(quotedSecret)
  expect(messages).toEqual([])
})

test('successful retest projects only validated health', async () => {
  const result = await runInNewContext(retestScript + '; retestConnection("/test", "CANARY-csrf")', {
    fetch: async () => Response.json({ status: 'ok', checkedAt: 1234, credentialRevision: 2, errorCode: null,
      diagnostic: { message: secret }, extra: quotedSecret }),
  })
  expect(result).toEqual({ health: { status: 'ok', checkedAt: 1234, credentialRevision: 2, errorCode: null } })
})
