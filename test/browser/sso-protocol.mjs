import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    const wait = page.wait.bind(page);
    page.wait = async (...args) => {
      try { await wait(...args); }
      catch (error) {
        if (!error.message.includes('Execution context was destroyed')) throw error;
        // A form reload can replace the document while its observer is active.
        await wait(...args);
      }
    };
    ${script}`)
}

beforeEach(async context => {
  server = spawn(process.execPath, ['test/fake-service/browser-auth.mjs'], {
    env: { ...process.env, ARTIUM_TEST_SSO: '1', ARTIUM_TEST_GENERIC_SSO: context.name.startsWith('generic') ? '1' : '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: server.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
    fixture = JSON.parse(line)
  } finally { lines.close() }
})

afterEach(async () => {
  if (server.exitCode !== null || server.signalCode !== null) return
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

function cli(args) {
  const child = spawn(process.execPath, ['dist/cli/artium-axi.mjs', ...args], {
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: fixture.clientHome, ARTIUM_AXI_URL: fixture.url, ARTIUM_AXI_CA_FILE: fixture.caFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = once(child, 'close', { signal: AbortSignal.timeout(30_000) }).then(([code]) => ({ code, stdout, stderr }))
  return { child, result }
}

async function cliDeviceCode(child) {
  const lines = createInterface({ input: child.stdout })
  try {
    for await (const line of lines) {
      if (line.startsWith('code: ')) return line.slice(6)
    }
    throw new Error('CLI exited without an approval code')
  } finally { lines.close() }
}

test('generic provider settings and credential are editable and activation is explicit', async () => {
  await configure({ enabled: false, localBreakGlass: true })
  await configure({ providerId: 'synthetic-generic', enabled: false })
  browser(`await page.open(base + '/login');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/login"] button');
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/settings/sign-in');
    await page.wait('form[action="/v1/admin/sso/providers"] [name=issuer]');
    await page.fill('form:has([name=issuer]) [name=name]', 'Synthetic created OIDC');
    await page.fill('form:has([name=issuer]) [name=issuer]', 'https://generic.example');
    await page.click('form:has([name=issuer]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tbody tr:nth-child(3)');
    const href = await page.eval(() => [...document.querySelectorAll('tbody a')].find(link => link.textContent === 'Synthetic created OIDC')?.getAttribute('href'));
    check(href, 'Created provider missing');
    await page.open(base + href);
    await page.wait('[data-credential-editor]');
    check(await page.eval(() => document.body.innerText.includes('OpenID Connect setup guide') && !document.querySelector('[name=tenantId]')), 'Generic settings show Entra requirements');
    await page.eval(() => {
      const select = document.querySelector('[name="profile.auth"]');
      select.value = JSON.stringify('secret'); select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.fill('[name="profile.clientId"]', 'synthetic-generic-client');
    await page.fill('[name="profile.clientSecret"]', 'CANARY-browser-oidc-secret');
    await page.click('form[action$="/credential"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/activation"]');
    check(await page.eval(() => document.querySelector('[name="profile.clientSecret"]').value === ''), 'Stored secret redisplayed');
    check(await page.eval(() => document.querySelector('form[action$="/activation"] [name=enabled]').value === 'true'), 'Credential save enabled provider');
    await page.click('form[action$="/activation"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/activation"] [name=enabled][value=false]');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Settings overflow');`)
})

test('generic provider and Entra are both offered and generic sign-in reaches its own account', async () => {
  browser(`await page.open(base + '/login');
    await page.wait('a[href="/auth/sso/synthetic-generic/start"]');
    check(await page.eval(() => !!document.querySelector('a[href="/auth/sso/synthetic-entra/start"]')), 'Entra provider missing');
    check(await page.eval(() => document.querySelector('a[href="/auth/sso/synthetic-generic/start"]').textContent === 'Sign in with synthetic-generic'), 'Generic provider mislabeled');
    await page.click('a[href="/auth/sso/synthetic-generic/start"]');
    await page.wait('[data-oidc-approve]');
    await page.click('[data-oidc-approve]');
    await page.wait('a[href="/account"]');
    await page.click('a[href="/account"]');
    await page.wait('section h2');
    check(await page.eval(() => document.body.innerText.includes('SSO sign-in')), 'Generic account session missing');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions[0].user_id, 'synthetic-generic-user')
  assert.equal(evidence.audit.at(-1).provider_id, 'synthetic-generic')
  assert.equal(evidence.audit.at(-1).subject, 'synthetic-subject')
})

test('generic callback routed to Entra is refused in the real browser', async () => {
  browser(`await page.open(base + '/auth/sso/synthetic-generic/start');
    await page.wait('[data-oidc-approve]');
    const callback = await page.eval(() => document.querySelector('[data-oidc-approve]').href);
    await page.open(callback.replace('/synthetic-generic/callback', '/synthetic-entra/callback'));
    await page.wait('main small');
    check(await page.eval(() => document.body.textContent.includes('SSO_STATE_INVALID')), 'Cross-provider callback accepted');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
})

test('generic named rules can be added edited previewed and removed through real pages', async () => {
  await configure({ localBreakGlass: true, claims: { groups: ['Readers'] } })
  await configure({ providerId: 'synthetic-generic', claims: { groups: ['Readers'] } })
  browser(`${signIn}
    await page.wait('a[href="/account"]');
    await page.open(base + '/auth/sso/synthetic-generic/start');
    await page.wait('[data-oidc-approve]');
    await page.click('[data-oidc-approve]');
    await page.wait('a[href="/account"]');
    await page.click('a[href="/account"]');
    await page.wait('form[action="/logout"]');
    await page.click('.account-menu summary');
    await page.click('form[action="/logout"] button');
    await page.wait('form[action="/login"]');
    await page.open(base + '/login');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/login"] button');
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/settings/sign-in/synthetic-generic');
    await page.wait('form[action="/v1/admin/sso/role-rules"]');
    await page.fill('form[action="/v1/admin/sso/role-rules"] [name=claim]', 'groups');
    await page.fill('form[action="/v1/admin/sso/role-rules"] [name=value]', 'Readers');
    await page.eval(() => { document.querySelector('form[action="/v1/admin/sso/role-rules"] [name=roleId]').value = 'synthetic-role'; });
    await page.click('form[action="/v1/admin/sso/role-rules"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('a[href*="/matches/"]');
    check(await page.eval(() => [...document.querySelectorAll('summary')].some(node => node.textContent.includes('Who matches: 1'))), 'Preview mixed providers or omitted saved claims');
    const matches = await page.eval(() => document.querySelector('a[href*="/matches/"]').getAttribute('href'));
    await page.open(base + matches);
    await page.wait('table');
    check(await page.eval(() => document.querySelector('tbody').innerText.includes('synthetic-generic-user') && document.querySelectorAll('tbody tr').length === 1), 'Who matches included another provider');
    await page.open(base + '/admin/settings/sign-in/synthetic-generic');
    await page.click('details:has(form[action*="/role-rules/"]) summary');
    await page.fill('details [name=claim]', 'custom.claim');
    await page.click('details form[data-method=PATCH] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('details [name=claim][value="custom.claim"]');
    check(await page.eval(() => [...document.querySelectorAll('summary')].some(node => node.textContent.includes('Who matches: 0'))), 'Claim edit did not refresh preview');
    await page.open(base + matches);
    await page.wait('main');
    check(await page.eval(() => document.querySelector('main').innerText.includes('No users match')), 'Empty match state missing');
    await page.open(base + '/admin/settings/sign-in/synthetic-generic');
    await page.click('details:has(form[action*="/role-rules/"]) summary');
    await page.click('details form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/sso/role-rules"]');
    check(await page.eval(() => !document.querySelector('a[href*="/matches/"]')), 'Removed rule still present');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.events.filter(event => event.action?.endsWith('role-rule')).map(event => event.action),
    ['create-role-rule', 'update-role-rule', 'delete-role-rule'])
})

test('generic ID token with another issuer is refused in the real browser', async () => {
  await configure({ providerId: 'synthetic-generic', claims: { iss: 'https://other.example' } })
  browser(`await page.open(base + '/auth/sso/synthetic-generic/start');
    await page.wait('[data-oidc-approve]');
    await page.click('[data-oidc-approve]');
    await page.wait('main small');
    check(await page.eval(() => document.body.textContent.includes('SSO_TOKEN_INVALID')), 'Issuer mix-up accepted');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
})

test('generic provider approves bundled CLI sign-in alongside Entra', async () => {
  const login = cli(['login', '--sso'])
  try {
    const code = await cliDeviceCode(login.child)
    browser(`await page.open(base + '/device?code=' + ${JSON.stringify(code)});
      await page.wait('[data-device-sso][href^="/auth/sso/synthetic-generic/"]');
      check(await page.eval(() => !!document.querySelector('[data-device-sso][href^="/auth/sso/synthetic-entra/"]')), 'Entra approval option missing');
      await page.click('[data-device-sso][href^="/auth/sso/synthetic-generic/"]');
      await page.wait('[data-oidc-approve]');
      await page.click('[data-oidc-approve]');
      await page.wait('a[href^="/device?code="]');
      await page.click('a[href^="/device?code="]');
      await page.wait('button[value=approve]');
      await page.click('button[value=approve]');`)
    const result = await login.result
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const me = await cli(['whoami']).result
    assert.equal(me.code, 0, me.stdout + me.stderr)
    assert.match(me.stdout, /synthetic-generic-user/)
  } finally { if (login.child.exitCode === null) login.child.kill() }
})

for (const decision of ['approve', 'deny', 'expire']) test(`bundled CLI device sign-in: ${decision}`, async () => {
  const login = cli(['login', '--sso'])
  try {
    const code = await cliDeviceCode(login.child)
    if (decision === 'expire') {
      const response = await fetch(fixture.clock, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: 600_000 }) })
      assert.equal(response.status, 200)
      browser(`await page.open(base + '/device?code=' + ${JSON.stringify(code)});
        await page.wait('main');
        check(await page.eval(() => document.body.textContent.includes('DEVICE_CODE_EXPIRED')), 'browser did not report expiry');`)
    } else browser(`await page.open(base + '/device');
      await page.fill('[name=code]', ${JSON.stringify(code)});
      await page.click('form[action="/device"] button');
      await page.wait('[data-device-sso]');
      await page.click('[data-device-sso]');
      await page.wait('[data-oidc-approve]');
      await page.click('[data-oidc-approve]');
      await page.wait('a[href^="/device?code="]');
      await page.click('a[href^="/device?code="]');
      await page.wait('button[value=approve]');
      check(await page.eval(() => document.body.textContent.includes('Requesting IP: 127.0.0.1') && document.body.textContent.includes('Requested:') && document.body.textContent.includes('Never approve a code someone sent you')), 'approval omitted request details or warning');
      check(await page.eval(() => document.querySelector('button[value=deny]').textContent === "This wasn't me"), 'denial action missing');
      check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'device page overflows');
      await page.click('button[value=${decision}]');
      await page.wait('main');`)
    const result = await login.result
    const sessionFile = join(fixture.clientHome, 'artium-axi', 'session.json')
    if (decision === 'approve') {
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /status: authenticated/)
      const session = JSON.parse(readFileSync(sessionFile, 'utf8'))
      assert.ok(!result.stdout.includes(session.accessToken) && !result.stdout.includes(session.refreshToken))
      const me = await cli(['whoami']).result
      assert.equal(me.code, 0, me.stdout + me.stderr)
      assert.match(me.stdout, /synthetic-browser-sso/)
      browser(`await page.open(base + '/device?code=' + ${JSON.stringify(code)});
        await page.wait('main');
        check(await page.eval(() => document.body.textContent.includes('DEVICE_CODE_INVALID')), 'consumed approval was reusable');`)
      browser(`await page.open(base + '/account');
        await page.wait('main');
        check(await page.eval(() => {
          const help = document.querySelector('.page-help').textContent;
          return help.includes('login --sso') && !help.includes('your local username') && !help.includes('Change password');
        }), 'SSO account help gives local password instructions');
        check(await page.eval(() => document.body.textContent.includes('login --sso') && document.body.textContent.includes('headless and SSH')), 'account CLI instructions missing');`)
    } else {
      assert.equal(result.code, 1, result.stdout + result.stderr)
      assert.match(result.stdout, decision === 'deny' ? /DEVICE_DENIED/ : /DEVICE_CODE_EXPIRED/)
      assert.equal(existsSync(sessionFile), false)
    }
  } finally { if (login.child.exitCode === null) login.child.kill() }
})

test('bundled CLI reports device creation rate limits without storing a session', async () => {
  for (let index = 0; index < 30; index++) {
    const response = await fetch(new URL('/v1/auth/device', fixture.clock), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 200)
  }
  const result = await cli(['login', '--sso']).result
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /AUTH_RATE_LIMITED/)
  assert.equal(existsSync(join(fixture.clientHome, 'artium-axi', 'session.json')), false)
})

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
    check(await page.eval(() => document.querySelector('[data-reauth-until]').innerText.includes('Changes unlocked')), 'Recent-auth window was not updated');`)
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
    await page.click('.account-menu summary');
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

test('SSO-enabled login page refuses an undesignated local administrator', async () => {
  await configure({ localBreakGlass: false })
  browser(`await page.open(base + '/login');
    check(await page.eval(() => document.querySelector('main').innerText.includes('designated break-glass administrators')), 'Password policy help is missing');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/login"] button');
    await page.wait('main small');
    check(await page.eval(() => document.querySelector('main').innerText.includes('SIGN_IN_FAILED')), 'Undesignated administrator was admitted');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.sessions.length, 0)
})

test('break-glass browser sign-in and password confirmation are highlighted in Audit', async () => {
  await configure({ localBreakGlass: true })
  browser(`await page.open(base + '/login');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/login"] button');
    await page.wait('nav[aria-label=Administration]');
    check(await page.eval(() => document.querySelector('.account-menu summary').innerText.includes('Break-glass')), 'Break-glass identity flag missing');`)
  assert.equal((await fetch(fixture.clock, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ advanceMs: 900_000 }) })).status, 200)
  browser(`await page.open(base + '/reauth');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/reauth"] button');
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/audit');
    await page.wait('.audit-table');
    check(await page.eval(() => Array.from(document.querySelectorAll('.audit-table strong')).filter(node => node.textContent === 'Break-glass').length === 2), 'Sign-in and confirmation were not highlighted');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.events.filter(event => ['sign-in', 'reauth'].includes(event.event))
    .map(event => ({ event: event.event, method: event.authentication_method })), [
    { event: 'sign-in', method: 'break-glass' }, { event: 'reauth', method: 'break-glass' },
  ])
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

test('administrator activates configured SSO through the guide and can disable it again', async () => {
  await configure({ enabled: false, localBreakGlass: true })
  browser(`await page.open(base + '/login');
    check(await page.eval(() => !document.querySelector('a[href="/auth/sso/synthetic-entra/start"]')), 'Disabled provider offered sign-in');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('form[action="/login"] button');
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/settings/sign-in/synthetic-entra');
    await page.wait('form[action$="/activation"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Entra setup guide') && document.querySelector('main').innerText.includes('Assignment required')), 'Setup instructions missing');
    const redirect = await page.eval(() => document.querySelector('[data-copy]').parentElement.querySelector('input').value);
    check(redirect === base + '/auth/sso/synthetic-entra/callback', 'Incorrect redirect URI');
    await page.eval(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async value => { window.copied = value; } }));
    await page.click('[data-copy]');
    check(await page.eval(() => window.copied === document.querySelector('[data-copy]').parentElement.querySelector('input').value && document.querySelector('[data-copy-status]').textContent === 'Copied.'), 'Copy failed');
    await page.eval(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Denied'); } }));
    await page.click('[data-copy]');
    check(await page.eval(() => document.activeElement.selectionEnd === document.activeElement.value.length && document.querySelector('[data-copy-status]').textContent.includes('manually')), 'Manual copy fallback missing');
    await page.click('form[action$="/activation"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/activation"] [name=enabled][value=false]');
    await page.open(base + '/admin/settings/sign-in');
    await page.wait('table');
    check(await page.eval(() => document.querySelector('tbody').innerText.includes('Enabled')), 'Activated status missing');
    await page.open(base + '/admin/settings/sign-in/synthetic-entra');
    await page.click('form[action$="/activation"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/activation"] [name=enabled][value=true]');
    await page.click('.account-menu summary');
    await page.click('form[action="/logout"] button');
    await page.wait('form[action="/login"]');
    check(await page.eval(() => !document.querySelector('a[href="/auth/sso/synthetic-entra/start"]')), 'Deactivated provider offered sign-in');`)
  const evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.equal(evidence.events.filter(event => event.action === 'update-local-policy').length, 2)
})

test('who matches previews new rules from last validated claims and refreshes after another sign-in', async () => {
  await invite()
  await configure({ administrator: true, claims: { roles: ['Artium.Reader', 'Artium.Extra'] } })
  browser(`${signIn}
    await page.wait('a[href="/admin"]');
    await page.click('a[href="/admin"]');
    await page.open(base + '/admin/settings/sign-in/synthetic-entra');
    await page.wait('form[action="/v1/admin/sso/role-rules"]');
    check(await page.eval(() => [...document.querySelectorAll('summary')].filter(node => node.textContent.includes('Who matches: 1')).length === 2), 'Validated role claims not counted');
    await page.fill('form[action="/v1/admin/sso/role-rules"] [name=value]', 'Artium.Extra');
    await page.eval(() => { document.querySelector('form[action="/v1/admin/sso/role-rules"] [name=roleId]').value = 'synthetic-role'; });
    await page.click('form[action="/v1/admin/sso/role-rules"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#reauth-dialog[open]');`)
  openReauthPopup()
  browser(`await page.click('[data-oidc-approve]');
    await page.wait('a[href="/reauth?complete=1"]');
    await page.click('a[href="/reauth?complete=1"]');`)
  selectPage('/admin/settings/sign-in/')
  browser(`await page.wait('#reauth-dialog:not([open])');
    check(await page.eval(() => [...document.querySelectorAll('summary')].some(node => node.textContent.includes('Artium.Extra') && node.textContent.includes('Who matches: 1'))), 'New rule preview depended on existing grants');`)
  await configure({ claims: { roles: [] } })
  browser(`${claim('/auth/sso/synthetic-entra/start')}
    await page.wait('a[href="/admin"]');
    await page.click('a[href="/admin"]');
    await page.open(base + '/admin/settings/sign-in/synthetic-entra');
    await page.wait('form[action="/v1/admin/sso/role-rules"]');
    check(await page.eval(() => [...document.querySelectorAll('summary')].filter(node => node.textContent.includes('Who matches: 0')).length === 3), 'Counts did not refresh after sign-in');`)
})

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
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/users');
    await page.wait('a[href="/admin/users/synthetic-development-user"]');
    await page.click('a[href="/admin/users/synthetic-development-user"]');
    await page.wait('section h2');
    check(await page.eval(() => document.querySelector('main').innerText.includes('From Entra ID rule synthetic-reader-rule') && document.querySelector('main').innerText.includes('Direct, SSO rule') && document.querySelector('.kv dd').textContent === 'SSO'), 'Linked account or grant labels missing');
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
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin/users');
    await page.wait('a[href="/admin/users/synthetic-development-user"]');
    await page.click('a[href="/admin/users/synthetic-development-user"]');
    await page.wait('section h2');
    check(await page.eval(() => !document.querySelector('main').innerText.includes('From Entra ID rule') && document.querySelector('main').innerText.includes('Synthetic Role · Direct') && ![...document.querySelectorAll('.chip')].some(chip => chip.textContent.includes('SSO rule'))), 'Rule labels or direct grant did not synchronize');
  `)
  evidence = await (await fetch(fixture.ssoEvidence)).json()
  assert.deepEqual(evidence.grants.filter(grant => grant.user_id === 'synthetic-development-user'), [
    { user_id: 'synthetic-development-user', role_id: 'synthetic-role', origin: 'direct' },
  ])
})
