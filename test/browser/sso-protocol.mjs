import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { after, afterEach, before, beforeEach, test } from 'node:test'

const environment = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `artium-sso-${process.pid}`,
  CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--ignore-certificate-errors' }
let server
let fixture

before(async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  environment.CHROME_DEVTOOLS_AXI_PORT = String(reservation.address().port)
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
})

function chrome(args, input) {
  const result = spawnSync('chrome-devtools-axi', args, { env: environment, input, encoding: 'utf8', timeout: 90_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

function browser(script) {
  return chrome(['run'], `const base = ${JSON.stringify(fixture.url)};
    const check = (value, message) => { if (!value) throw new Error(message); };
    ${script}`)
}

beforeEach(async () => {
  server = spawn(process.execPath, ['test/fake-service/browser-auth.mjs'], {
    env: { ...process.env, ARTIUM_TEST_SSO: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: server.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
    fixture = JSON.parse(line)
  } finally { lines.close() }
})

afterEach(async () => {
  const exited = once(server, 'exit')
  server.kill('SIGTERM')
  await exited
})

after(() => chrome(['stop']))

async function configure(value) {
  const response = await fetch(fixture.ssoControl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal(response.status, 200)
}

const signIn = `await page.open(base + '/login');
  await page.wait('a[href="/auth/sso/synthetic-entra/start"]');
  check(await page.eval(() => document.querySelector('a[href="/auth/sso/synthetic-entra/start"]').tagName === 'A'), 'SSO must start through a plain link');
  await page.click('a[href="/auth/sso/synthetic-entra/start"]');
  await page.wait('[data-oidc-approve]');
  await page.click('[data-oidc-approve]');`

test('CSP-compatible link and Strict-cookie callback hop establish an SSO account session', async () => {
  browser(`${signIn}
    await page.wait('a[href="/account"]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Sign-in complete'), 'Callback did not finish');
    await page.click('a[href="/account"]');
    await page.wait('table[aria-label], section h2');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic browser SSO') && document.querySelector('main').innerText.includes('SSO sign-in')), 'Strict session cookie was not accepted after hop');
    await page.open(base + '/auth/sso/synthetic-entra/start');
    await page.wait('[data-oidc-approve]');
    await page.click('[data-oidc-approve]');
    await page.wait('a[href="/account"]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Sign-in complete'), 'Second callback did not finish');
    await page.click('a[href="/account"]');
    await page.wait('section h2');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.callbackCookies, { session: false, preauth: true, csrf: false })
  assert.equal(evidence.sessions.length, 2)
  assert.equal(evidence.audit.length, 2)
  assert.ok(evidence.audit.every(event => event.outcome === 'success'))
})

test('uninvited identity is refused without creating a session', async () => {
  await configure({ claims: { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'synthetic-browser-sso' } })
  browser(`${signIn}
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_NOT_INVITED')), 'Uninvited identity was not refused');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
  assert.equal(evidence.audit.at(-1).outcome, 'SSO_NOT_INVITED')
})

test('tampered ID token is refused in the real callback page', async () => {
  await configure({ tamperSignature: true })
  browser(`${signIn}
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_TOKEN_INVALID')), 'Tampered signature was accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
  assert.equal(evidence.audit.at(-1).outcome, 'SSO_TOKEN_INVALID')
})

test('wrong ID token issuer is refused in the real callback page', async () => {
  await configure({ claims: { iss: 'https://other.example' } })
  browser(`${signIn}
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_TOKEN_INVALID')), 'Wrong issuer was accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
  assert.equal(evidence.audit.at(-1).outcome, 'SSO_TOKEN_INVALID')
})

test('replaying a completed callback cannot issue another session', async () => {
  browser(`${signIn}
    await page.wait('a[href="/account"]');
    const callback = await page.eval(() => location.href);
    await page.click('a[href="/account"]');
    await page.wait('section h2');
    await page.open(callback);
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_STATE_INVALID')), 'Callback replay was accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 1)
  assert.deepEqual(evidence.audit.map(event => event.outcome), ['success', 'SSO_STATE_INVALID'])
})
