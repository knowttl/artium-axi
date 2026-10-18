import { constants, verify, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestCertificates } from '../../../test/fake-service/certificates.mjs'
import { FakeTokenTransport, azureTestEndpoint as endpoint, azureTestTenant as tenantId,
  azureTestToken as accessToken } from '../../../test/fixtures/azure-token-transport.js'
import { ArtiumError, errorResponse } from '../../shared/errors.js'
import { SecretScanner } from '../runner/scan.js'
import { azureAudiences, azureCredentialSchema, mintAzureToken } from './azure-tokens.js'
import type { AzureCredential, AzureResource } from './azure-tokens.js'

const clientId = '22222222-2222-4222-8222-222222222222'
const secretCredential = { tenantId, clientId, auth: 'secret', clientSecret: 'CANARY-AZURE-CLIENT-SECRET' } as const

describe('Azure token authentication', () => {
  let directory: string
  let certificate: X509Certificate
  let certificateCredential: AzureCredential

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'artium-azure-auth-'))
    createTestCertificates(directory, ['azure.synthetic.invalid'])
    certificate = new X509Certificate(readFileSync(join(directory, 'server.crt')))
    certificateCredential = { tenantId, clientId, auth: 'certificate',
      privateKey: readFileSync(join(directory, 'server.key'), 'utf8'),
      thumbprintSha256: certificate.fingerprint256.replaceAll(':', '') }
  })
  afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

  it('mints a secret-authenticated token through the MSAL transport', async () => {
    const network = new FakeTokenTransport()
    const result = await mintAzureToken(secretCredential, 'arm', network)
    expect(result.accessToken).toBe(accessToken)
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500_000)
    expect(result.secrets).toEqual([secretCredential.clientSecret, accessToken])
    expect(network.requests).toHaveLength(1)
    const url = new URL(network.requests[0].url)
    expect(`${url.origin}${url.pathname}`).toBe(endpoint)
    expect(Object.fromEntries(network.requests[0].form)).toMatchObject({ client_id: clientId,
      client_secret: secretCredential.clientSecret, grant_type: 'client_credentials' })
    expect(network.requests[0].form.has('client_assertion')).toBe(false)
  })

  it('signs a certificate assertion with the matching thumbprint and returns it for scanning', async () => {
    const network = new FakeTokenTransport()
    const result = await mintAzureToken(certificateCredential, 'graph', network)
    const form = network.requests[0].form
    const assertion = form.get('client_assertion')!
    const [header, payload, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'PS256',
      'x5t#S256': Buffer.from(certificate.fingerprint256.replaceAll(':', ''), 'hex').toString('base64url') })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: clientId, sub: clientId, aud: endpoint })
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: certificate.publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signature, 'base64url'))).toBe(true)
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    expect(form.has('client_secret')).toBe(false)
    expect(result.secrets).toEqual([certificateCredential.auth === 'certificate' ? certificateCredential.privateKey : '', assertion, accessToken])
    expect(new SecretScanner(result.secrets).scan('stdout', Buffer.from(assertion))).toBe(true)
  })

  it('refuses an unusable private key before sending a token request', async () => {
    const network = new FakeTokenTransport()
    await expect(mintAzureToken({ ...certificateCredential, privateKey: 'CANARY-INVALID-PRIVATE-KEY' }, 'arm', network))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(network.requests).toHaveLength(0)
  })

  it('hides certificate rejection details including the submitted assertion', async () => {
    const network = new FakeTokenTransport()
    network.sendPostRequestAsync = async (_url, options) => {
      throw new Error(`CANARY-CERTIFICATE-REJECTED ${options?.body}`)
    }
    const error = await mintAzureToken(certificateCredential, 'arm', network).catch(error => error as ArtiumError)
    expect(error).toBeInstanceOf(ArtiumError)
    expect(errorResponse(error as ArtiumError, 'synthetic-request')).toEqual(errorResponse(new ArtiumError('UPSTREAM_NETWORK_FAILED'), 'synthetic-request'))
    expect((error as ArtiumError).cause).toBeUndefined()
  })

  it('reports certificate signature rejection from the authority safely', async () => {
    const network = new FakeTokenTransport()
    network.status = 400
    network.response = { error: 'invalid_client', error_description: 'AADSTS700027: CANARY-SIGNATURE-REJECTED' }
    await expect(mintAzureToken(certificateCredential, 'arm', network)).rejects.toMatchObject({
      code: 'UPSTREAM_AUTH_FAILED', message: new ArtiumError('UPSTREAM_AUTH_FAILED').message,
      diagnostic: { stage: 'token acquisition', toolCode: 'AADSTS700027' },
    })
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0].form.has('client_assertion')).toBe(true)
  })

  it.each([
    ['AADSTS7000215', 'secret is invalid'],
    ['AADSTS7000222', 'secret expired'],
    ['AADSTS700016', 'application was not found'],
    ['AADSTS90002', 'tenant was not found'],
  ])('keeps %s and actionable advice without forwarding the provider body', async (code, advice) => {
    const network = new FakeTokenTransport()
    network.status = 400
    network.response = { error: 'invalid_client', error_description: `${code}: ${secretCredential.clientSecret} CANARY-RAW-RESPONSE` }
    const error = await mintAzureToken(secretCredential, 'arm', network).catch(error => error as ArtiumError)
    expect(error).toMatchObject({ code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: code,
      hint: expect.stringContaining(advice) } })
    expect(JSON.stringify(error)).not.toContain(secretCredential.clientSecret)
    expect(JSON.stringify(error)).not.toContain('CANARY-RAW-RESPONSE')
    expect(errorResponse(error as ArtiumError, 'synthetic')).not.toHaveProperty('error.diagnostic')
  })

  it.each([
    [400, 'temporarily_unavailable'],
    [400, 'server_error'],
    [429, 'slow_down'],
    [500, 'unexpected_service_error'],
    [502, 'server_error'],
    [503, 'temporarily_unavailable'],
    [504, 'unexpected_service_error'],
  ] as const)('classifies token HTTP %s / %s as a service failure without forwarding its body', async (status, code) => {
    const network = new FakeTokenTransport()
    network.status = status
    network.response = { error: code, error_description: `${secretCredential.clientSecret} CANARY-RAW-SERVICE-RESPONSE` }
    const error = await mintAzureToken(secretCredential, 'arm', network).catch(error => error as ArtiumError)
    expect(error).toMatchObject({ code: 'TOOL_FAILED', diagnostic: {
      stage: 'token acquisition', host: 'login.microsoftonline.com', toolCode: code,
      hint: expect.stringContaining('service availability'),
    } })
    expect(JSON.stringify(error)).not.toContain(secretCredential.clientSecret)
    expect(JSON.stringify(error)).not.toContain('CANARY-RAW-SERVICE-RESPONSE')
  })

  it('drops service diagnostics when a retained code matches the credential secret', async () => {
    const network = new FakeTokenTransport()
    network.status = 503
    network.response = { error: 'temporarily_unavailable' }
    const error = await mintAzureToken({ ...secretCredential, clientSecret: 'temporarily_unavailable' }, 'arm', network)
      .catch(error => error as ArtiumError)
    expect(error).toMatchObject({ code: 'TOOL_FAILED' })
    expect((error as ArtiumError).diagnostic).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('temporarily_unavailable')
  })

  it.each([
    ['GET', 200, '<html>CANARY-RAW-RESPONSE</html>', 'TOOL_FAILED'],
    ['GET', 503, '', 'TOOL_FAILED'],
    ['GET', 429, '<html>CANARY-RAW-RESPONSE</html>', 'TOOL_FAILED'],
    ['POST', 503, `<html>${secretCredential.clientSecret} CANARY-RAW-RESPONSE</html>`, 'TOOL_FAILED'],
    ['POST', 503, '', 'TOOL_FAILED'],
    ['POST', 429, '', 'TOOL_FAILED'],
    ['POST', 429, '<html>CANARY-RAW-RESPONSE</html>', 'TOOL_FAILED'],
    ['POST', 502, '', 'TOOL_FAILED'],
    ['POST', 503, '{"error":"temporarily_unavailable"}', 'TOOL_FAILED'],
    ['POST', 500, '{"error":"server_error"}', 'TOOL_FAILED'],
    ['POST', 400, '', 'UPSTREAM_AUTH_FAILED'],
    ['POST', 400, '{"error":"temporarily_unavailable"}', 'TOOL_FAILED'],
    ['POST', 401, '<html>CANARY-RAW-RESPONSE</html>', 'UPSTREAM_AUTH_FAILED'],
    ['POST', 403, '', 'UPSTREAM_AUTH_FAILED'],
    ['POST', 400, '{"error":"invalid_client","error_description":"AADSTS7000215: CANARY-RAW-RESPONSE"}', 'UPSTREAM_AUTH_FAILED'],
    ['POST', 200, '<html>CANARY-RAW-RESPONSE</html>', 'TOOL_FAILED'],
  ] as const)('classifies production %s HTTP %s responses independently of body format', async (method, status, body, code) => {
    const network = new FakeTokenTransport()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (options?.method === method) return new Response(body, { status })
      const response = await network.sendGetRequestAsync(String(input))
      return Response.json(response.body, { status: response.status })
    })
    try {
      const error = await mintAzureToken(secretCredential, 'arm', undefined, new AbortController().signal).catch(error => error as ArtiumError)
      expect(error).toMatchObject({ code, diagnostic: { stage: 'token acquisition', host: 'login.microsoftonline.com' } })
      expect(JSON.stringify(error)).not.toContain('CANARY-RAW-RESPONSE')
      expect(JSON.stringify(error)).not.toContain(secretCredential.clientSecret)
    } finally { fetch.mockRestore() }
  })

  it.each(['GET', 'POST'])('keeps production %s body-read transport failures distinct from malformed JSON', async method => {
    const network = new FakeTokenTransport()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (options?.method === method) return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('terminated', { cause: { code: 'ECONNRESET' } })) },
      }), { status: 200 })
      const response = await network.sendGetRequestAsync(String(input))
      return Response.json(response.body, { status: response.status })
    })
    try {
      await expect(mintAzureToken(secretCredential, 'arm', undefined, new AbortController().signal)).rejects.toMatchObject({
        code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'token acquisition', host: 'login.microsoftonline.com' },
      })
    } finally { fetch.mockRestore() }
  })

  it('keeps production transport failures distinct from HTTP failures', async () => {
    const network = new FakeTokenTransport()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
      const response = await network.sendGetRequestAsync(String(input))
      return Response.json(response.body, { status: response.status })
    })
    try {
      await expect(mintAzureToken(secretCredential, 'arm', undefined, new AbortController().signal)).rejects.toMatchObject({
        code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'token acquisition', host: 'login.microsoftonline.com' },
      })
    } finally { fetch.mockRestore() }
  })

  it.each([
    ['arm', 'https://management.azure.com//.default'],
    ['logs', 'https://api.loganalytics.io/.default'],
    ['graph', 'https://graph.microsoft.com/.default'],
    ['storage', 'https://storage.azure.com//.default'],
    ['vault', 'https://vault.azure.net//.default'],
    ['registry', 'https://containerregistry.azure.net/.default'],
  ] as const)('requests only the fixed %s scope', async (resource, scope) => {
    const network = new FakeTokenTransport()
    await mintAzureToken(secretCredential, resource, network)
    expect(network.requests.map(request => request.form.get('scope'))).toEqual([scope])
  })

  it('refuses an unknown resource before any token request', async () => {
    const network = new FakeTokenTransport()
    await expect(mintAzureToken(secretCredential, 'custom' as AzureResource, network)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(network.requests).toHaveLength(0)
    expect(Object.keys(azureAudiences)).toEqual(['arm', 'logs', 'graph', 'storage', 'vault', 'registry'])
  })

  it.each([
    { ...secretCredential, clientSecret: '' },
    { ...secretCredential, tenantId: '../common' },
    { ...secretCredential, privateKey: 'CANARY-MIXED-CREDENTIAL' },
    { tenantId, clientId, auth: 'certificate', privateKey: 'CANARY-KEY' },
    { tenantId, clientId, auth: 'certificate', privateKey: 'CANARY-KEY', thumbprintSha256: 'invalid' },
  ])('rejects malformed or mixed credentials', async credential => {
    expect(azureCredentialSchema.safeParse(credential).success).toBe(false)
    const network = new FakeTokenTransport()
    await expect(mintAzureToken(credential, 'arm', network)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(network.requests).toHaveLength(0)
  })

  it('does not emit secret-bearing transport diagnostics', async () => {
    const stdout = vi.spyOn(process.stdout, 'write')
    const stderr = vi.spyOn(process.stderr, 'write')
    try {
      const network = new FakeTokenTransport()
      network.failure = `CANARY-DIAGNOSTIC ${secretCredential.clientSecret}`
      await expect(mintAzureToken(secretCredential, 'arm', network)).rejects.toMatchObject({
        code: 'UPSTREAM_NETWORK_FAILED', message: new ArtiumError('UPSTREAM_NETWORK_FAILED').message,
      })
      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
    } finally { stdout.mockRestore(); stderr.mockRestore() }
  })

  it.each([
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_NOT_YET_VALID',
    'CERT_HAS_EXPIRED', 'CERTIFICATE_VERIFY_FAILED', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'HOSTNAME_MISMATCH', 'INVALID_PURPOSE',
    'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'CRL_SIGNATURE_FAILURE', 'UNABLE_TO_GET_CRL',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
    'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  ])('preserves TLS verification code %s from token transport failures', async code => {
    const network = new FakeTokenTransport()
    network.sendPostRequestAsync = async () => {
      throw new Error(`fetch failed ${secretCredential.clientSecret}`, { cause: { code } })
    }
    const error = await mintAzureToken(secretCredential, 'arm', network).catch(error => error as ArtiumError)
    expect(error).toMatchObject({ code: 'UPSTREAM_TLS_FAILED', diagnostic: {
      stage: 'TLS', host: 'login.microsoftonline.com', toolCode: code,
    } })
    expect(JSON.stringify(error)).not.toContain(secretCredential.clientSecret)
  })

  it('keeps token and assertion values out of files during authentication', async () => {
    const harness = join(directory, 'azure-auth.cjs')
    await build({ entryPoints: ['test/fake-service/azure-auth.ts'], bundle: true, platform: 'node',
      format: 'cjs', outfile: harness })
    const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission'
    const output = execFileSync(process.execPath, [permission, '--allow-fs-read=*', harness], {
      cwd: directory, input: JSON.stringify([secretCredential, certificateCredential]), encoding: 'utf8', timeout: 10_000,
    })
    expect(JSON.parse(output)).toEqual({ requests: 2, secretScanned: true, assertionScanned: true })
  })
})
