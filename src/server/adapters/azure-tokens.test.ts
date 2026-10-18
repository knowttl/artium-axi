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
