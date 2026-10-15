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

function selectPage(urlPart) {
  const pages = chrome(['pages'])
  const row = pages.split('\n').find(line => line.includes(urlPart))
  assert.ok(row, pages)
  const id = /^\s*(\d+),/.exec(row)?.[1]
  assert.ok(id, pages)
  chrome(['selectpage', id])
}

const prepareChange = `${signIn}
  await page.wait('a[href="/admin"]');
  await page.click('a[href="/admin"]');
  await page.open(base + '/admin/roles');
  await page.wait('form[action="/v1/admin/roles"]');
  await page.fill('form[action="/v1/admin/roles"] [name=name]', 'Synthetic resumed role');
  await page.click('form[action="/v1/admin/roles"] button');
  await page.wait('#reauth-dialog[open]');
  check(await page.eval(() => !document.querySelector('#reauth-dialog [name=password]')), 'SSO asked for a local password');`

function openReauthPopup() {
  browser(`await page.click('#reauth-dialog button:not([type=button])');`)
  selectPage('/reauth')
  browser(`await page.wait('[data-sso-reauth-start]');
    await page.click('[data-sso-reauth-start]');
    await page.wait('[data-oidc-approve]');`)
}

test('SSO identity confirmation resumes the pending form through the real popup and Strict-cookie hop', async () => {
  await configure({ administrator: true })
  browser(prepareChange)
  openReauthPopup()
  browser(`await page.click('[data-oidc-approve]');
    await page.wait('a[href="/reauth?complete=1"]');
    await page.click('a[href="/reauth?complete=1"]');`)
  selectPage('/admin/roles')
  browser(`await page.wait('a[href^="/admin/roles/"]');
    await page.wait('#reauth-dialog:not([open])');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic resumed role')), 'Pending role was not saved');
    check(await page.eval(() => document.querySelector('[data-reauth-until]').innerText.includes('Changes allowed for')), 'Recent-auth window was not updated');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.callbackCookies, { session: false, preauth: true, csrf: false })
  assert.equal(evidence.authorizations.at(-1).prompt, 'login')
  assert.equal(evidence.sessions.length, 1)
  assert.ok(evidence.sessions[0].reauthenticated_at)
  assert.equal(evidence.events.filter(event => event.event === 'reauth').length, 1)
})

test('cancelled SSO confirmation keeps the entered draft without making the change', async () => {
  await configure({ administrator: true })
  browser(`${prepareChange}
    await page.click('[data-reauth-cancel]');
    await page.wait('#reauth-dialog:not([open])');
    check(await page.eval(() => document.querySelector('form[action="/v1/admin/roles"] [name=name]').value === 'Synthetic resumed role'), 'Cancelled confirmation lost the draft');
    check(await page.eval(async () => !(await (await fetch('/v1/admin/roles')).json()).roles.some(role => role.name === 'Synthetic resumed role')), 'Cancelled action created a role');`)
})

test('stale provider authentication is refused and leaves the pending draft intact', async () => {
  await configure({ administrator: true, claims: { auth_time: 1 } })
  browser(prepareChange)
  openReauthPopup()
  browser(`await page.click('[data-oidc-approve]');
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_TOKEN_INVALID')), 'Stale authentication was accepted');`)
  selectPage('/admin/roles')
  browser(`await page.click('[data-reauth-cancel]');
    await page.wait('#reauth-dialog:not([open])');
    check(await page.eval(() => document.querySelector('form[action="/v1/admin/roles"] [name=name]').value === 'Synthetic resumed role'), 'Failed confirmation lost the draft');
    check(await page.eval(async () => !(await (await fetch('/v1/admin/roles')).json()).roles.some(role => role.name === 'Synthetic resumed role')), 'Failed confirmation created a role');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions[0].reauthenticated_at, null)
  assert.equal(evidence.audit.at(-1).outcome, 'SSO_TOKEN_INVALID')
})

test('optional Microsoft sign-out revokes artium before visiting the fake provider logout page', async () => {
  browser(`${signIn}
    await page.wait('a[href="/account"]');
    await page.click('a[href="/account"]');
    await page.wait('form[action="/logout"]');
    await page.click('[name=providerLogout]');
    await page.click('form[action="/logout"] button');
    await page.wait('[data-provider-signout]');
    await page.click('[data-provider-signout]');
    await page.wait('a[href$="/login"]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Signed out of synthetic provider'), 'Provider logout did not run');
    await page.click('a');
    await page.wait('[name=username]');
    await page.open(base + '/account');
    await page.wait('[name=username]');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
  assert.equal(evidence.events.at(-1).event, 'sign-out')
})

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

async function invite(options = {}) {
  const response = await fetch(fixture.ssoControl.replace('sso-protocol', 'sso-invitation'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options),
  })
  assert.equal(response.status, 200)
  return response.json()
}

const claim = path => `await page.open(base + ${JSON.stringify(path)});
  await page.wait('[data-oidc-approve]');
  await page.click('[data-oidc-approve]');`

test('invitation claim grants direct and rule roles and a reused link is refused', async () => {
  const invitation = await invite()
  await configure({ claims: { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'synthetic-invited' } })
  browser(`${claim(invitation.claimPath)}
    await page.wait('a[href="/account"]');
    await page.click('a[href="/account"]');
    await page.wait('section h2');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic invited user')), 'Claimed account missing');
    await page.open(base + ${JSON.stringify(invitation.claimPath)});
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_INVITE_INVALID')), 'Reused link accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  const userId = evidence.invitations[0].user_id
  assert.ok(evidence.invitations[0].claimed_at)
  assert.deepEqual(evidence.grants.filter(grant => grant.user_id === userId).map(({ role_id, origin }) => ({ role_id, origin })), [
    { role_id: 'synthetic-role', origin: 'direct' }, { role_id: 'synthetic-role', origin: 'synthetic-overlap-rule' },
    { role_id: 'synthetic-rule-role', origin: 'synthetic-reader-rule' },
  ])
  assert.equal(evidence.sessions.length, 1)
})

test('wrong-username claim refuses the identity and leaves the invitation unused', async () => {
  const invitation = await invite()
  await configure({ claims: { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'Synthetic-Invited' } })
  browser(`${claim(invitation.claimPath)}
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_INVITE_INVALID')), 'Wrong username accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.invitations[0].claimed_at, null)
  assert.equal(evidence.sessions.length, 0)
})

test('expired invitation link is refused before provider sign-in', async () => {
  const invitation = await invite()
  assert.equal((await fetch(fixture.clock, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ advanceMs: 86_400_000 }) })).status, 200)
  browser(`await page.open(base + ${JSON.stringify(invitation.claimPath)});
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SSO_INVITE_INVALID')), 'Expired link accepted');
  `)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
  assert.equal(evidence.invitations[0].claimed_at, null)
})

test('local account linking keeps the account and role sync removes only rule access on the next sign-in', async () => {
  const invitation = await invite({ userId: 'synthetic-development-user' })
  await configure({ claims: { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'synthetic-invited' } })
  browser(`${claim(invitation.claimPath)}
    await page.wait('a[href="/admin"]');
    await page.click('a[href="/admin"]');
    await page.wait('a[href="/admin/users/synthetic-development-user"]');
    await page.click('a[href="/admin/users/synthetic-development-user"]');
    await page.wait('section h2');
    check(await page.eval(() => document.querySelector('main').innerText.includes('From Entra rule synthetic-reader-rule') && document.querySelector('main').innerText.includes('(Direct, Rule)') && document.querySelector('main').innerText.includes('Sign-in source: SSO')), 'Linked account or grant labels missing');
  `)
  let evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.invitations[0].user_id, 'synthetic-development-user')
  assert.equal(evidence.users.find(user => user.id === 'synthetic-development-user').password_hash, null)
  assert.ok(evidence.events.some(event => event.event === 'identity-link'))
  assert.equal(evidence.grants.filter(grant => grant.user_id === 'synthetic-development-user').length, 3)
  await configure({ claims: { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'synthetic-invited', roles: [] } })
  browser(`${claim('/auth/sso/synthetic-entra/start')}
    await page.wait('a[href="/admin"]');
    await page.click('a[href="/admin"]');
    await page.wait('a[href="/admin/users/synthetic-development-user"]');
    await page.click('a[href="/admin/users/synthetic-development-user"]');
    await page.wait('section h2');
    check(await page.eval(() => !document.querySelector('main').innerText.includes('From Entra rule') && document.querySelector('main').innerText.includes('(Direct)')), 'Rule labels or direct grant did not synchronize');
  `)
  evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.grants.filter(grant => grant.user_id === 'synthetic-development-user'), [
    { user_id: 'synthetic-development-user', role_id: 'synthetic-role', origin: 'direct' },
  ])
})
