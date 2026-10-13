import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'

// Replace only the network/auth SDK boundary. Any keychain import fails the probe.
const sdk = `import { createPrivateKey } from 'node:crypto'
export class ConfidentialClientApplication {
  constructor(config) { this.config = config }
  async acquireTokenByClientCredential({ scopes }) {
    const auth = this.config.auth
    if (auth.clientSecret !== 'CANARY-secret' && !auth.clientCertificate)
      throw new Error('Unexpected credential at fake SDK boundary')
    if (auth.clientCertificate && createPrivateKey(auth.clientCertificate.privateKey).asymmetricKeyType !== 'rsa')
      throw new Error('Unexpected private key at fake SDK boundary')
    if (auth.clientCertificate && auth.clientCertificate.thumbprintSha256 !== 'a'.repeat(64))
      throw new Error('Unexpected certificate thumbprint')
    if (scopes.join() !== 'https://graph.microsoft.com/.default') throw new Error('Unexpected scopes')
    return { authority: auth.authority + '/', accessToken: 'CANARY-token', expiresOn: new Date('2030-01-01') }
  }
}`
const loader = `export async function resolve(name, context, next) {
  if (name === 'keytar') throw new Error('Keychain unavailable in headless probe')
  if (name === '@azure/msal-node') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(sdk)}`)}, shortCircuit: true }
  return next(name, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`)
const upstream = '../../tools/node_modules/@knowttl/mg-axi/dist/'
const { executeArgv } = await import(new URL(`${upstream}cli.js`, import.meta.url))
const { Profiles, validateProfile } = await import(new URL(`${upstream}profiles.js`, import.meta.url))
const { MsalApplicationProvider } = await import(new URL(`${upstream}msal-app-provider.js`, import.meta.url))
const { resolveCommand, LEAVES } = await import(new URL(`${upstream}catalogue.js`, import.meta.url))
const directory = mkdtempSync('/tmp/mg-headless-')
process.env.MG_AXI_CONFIG = `${directory}/profiles.json`
const secretFile = `${directory}/secret`
const keyFile = `${directory}/key`
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
writeFileSync(secretFile, 'CANARY-secret\n', { mode: 0o600 })
writeFileSync(keyFile, privateKey, { mode: 0o600 })
process.env.CANARY_SECRET = 'CANARY-secret'
process.env.CANARY_KEY = privateKey.replace(/\n/g, '\\n')
const cases = [
  ['secret-env', ['--client-secret-env', 'CANARY_SECRET']],
  ['secret-file', ['--client-secret-file', secretFile]],
  ['certificate-env', ['--certificate-thumbprint-sha256', 'A'.repeat(64), '--certificate-key-env', 'CANARY_KEY']],
  ['certificate-file', ['--certificate-thumbprint-sha256', 'A'.repeat(64), '--certificate-key-file', keyFile]],
]
try {
  for (const [name, flags] of cases) {
    await executeArgv(['profile', 'create', '--name', name, '--tenant', '00000000-0000-0000-0000-000000000001',
      '--client', '00000000-0000-0000-0000-000000000002', '--cloud', 'commercial', '--mode', 'application', ...flags])
    const profile = new Profiles().resolve(name).profile
    const provider = new MsalApplicationProvider()
    const result = await provider.acquire(profile, [])
    assert.equal(result.token, 'CANARY-token')
    assert.equal(provider.storage, 'session-only')
    await assert.rejects(executeArgv(['auth', 'login', '--profile', name, '--scopes', 'https://graph.microsoft.com/User.Read']),
      error => error.code === 'VALIDATION_ERROR')
    console.log(`headless-case: ${name} acquired through fake SDK; interactive login refused`)
  }
  const profile = new Profiles().resolve('secret-env').profile
  delete process.env.CANARY_SECRET
  await assert.rejects(new MsalApplicationProvider().acquire(profile, []), error => error.code === 'AUTH_REQUIRED')
  const certificate = new Profiles().resolve('certificate-env').profile
  delete process.env.CANARY_KEY
  await assert.rejects(new MsalApplicationProvider().acquire(certificate, []), error => error.code === 'AUTH_REQUIRED')
  process.env.CANARY_KEY = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nCANARY'
  await assert.rejects(new MsalApplicationProvider().acquire(certificate, []), error => error.code === 'AUTH_REQUIRED')
  for (const [name, file] of [['secret-file', secretFile], ['certificate-file', keyFile]]) {
    const profile = new Profiles().resolve(name).profile
    chmodSync(file, 0o644)
    await assert.rejects(new MsalApplicationProvider().acquire(profile, []), error => error.code === 'CONFIG_INSECURE')
    chmodSync(file, 0o600)
    const link = `${file}-link`
    symlinkSync(file, link)
    await assert.rejects(new MsalApplicationProvider().acquire({ ...profile,
      [name === 'secret-file' ? 'clientSecret' : 'privateKey']: { file: link } }, []),
      error => error.code === 'CONFIG_INSECURE')
  }
  assert.throws(() => validateProfile({ ...profile, allowDeviceCode: true }))
  assert.throws(() => validateProfile({ ...profile, clientSecret: 'CANARY-inline' }))
  assert.throws(() => validateProfile({ ...profile, clientSecret: { file: 'relative' } }))
  const config = readFileSync(process.env.MG_AXI_CONFIG, 'utf8')
  assert.ok(!config.includes('CANARY-secret') && !config.includes('BEGIN PRIVATE KEY'))
  for (const leaf of LEAVES) assert.equal(resolveCommand([...leaf.path.split(' '), '--help']).flags.help, true)
  for (const args of [['entra', 'user', 'list', '-h'], ['entra', 'user', 'list', '--'],
    ['entra', 'user', 'list', '--profile', 'one', '--profile', 'two'],
    ['--profile', 'one', 'entra', 'user', 'list'], ['entra', 'user', 'list', '--json'],
    ['entra', 'user', 'list', '--version']]) assert.throws(() => resolveCommand(args))
  assert.equal(resolveCommand(['entra', 'user', 'list', '--profile=synthetic']).flags.profile, 'synthetic')
  for (const flag of ['--version', '-v', '-V']) {
    const result = spawnSync(process.execPath, [new URL(`${upstream}bin/mg-axi.js`, import.meta.url).pathname, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), '0.1.6')
  }
  console.log(`headless-case: missing/env, encrypted/key, mode/file, symlink/file and invalid/profile refused; ${LEAVES.length} parser leaves verified`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
