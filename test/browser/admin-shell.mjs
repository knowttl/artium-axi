import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { after, afterEach, before, beforeEach, test } from 'node:test'

const environment = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `artium-shell-${process.pid}`,
  CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--ignore-certificate-errors' }
let server
let fixture

before(async () => {
  // Session-name hashes can collide with other browser workers on this host.
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
        // A form reload destroys the old document's observer. Re-query the new document.
        await wait(...args);
      }
    };
    ${script}`)
}

beforeEach(async () => {
  server = spawn(process.execPath, ['test/fake-service/browser-auth.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = createInterface({ input: server.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
    fixture = JSON.parse(line)
  } finally { lines.close() }
  browser(`
    await page.open(base + '/login');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('[name=newPassword]');
    await page.fill('[name=newPassword]', 'CANARY-browser-password');
    await page.click('form[action="/password"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-user');
    await page.fill('[name=password]', 'CANARY-browser-password');
    await page.click('button');
    await page.wait('nav[aria-label=Administration] a[href="/admin"][aria-current=page]');
    await page.open(base + '/admin/users');
    await page.wait('form[action="/v1/admin/users"]');
  `)
})

afterEach(async () => {
  if (server.exitCode !== null || server.signalCode !== null) return
  const exited = once(server, 'exit')
  server.kill('SIGTERM')
  await exited
})

after(() => chrome(['stop']))

async function expireConfirmation() {
  const response = await fetch(fixture.clock, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ advanceMs: 900_000 }) })
  assert.equal(response.status, 200)
}

test('GitHub device connection shows the code, stores approval and cancels reconnect without replacement', () => {
  browser(`
    await page.open(base + '/admin/tools/gh-axi');
    await page.eval(async () => { await fetch('/test/trust-ca', { method: 'POST' }); });
    await page.fill('[data-connect-github] [name=origin]', base);
    await page.click('[data-connect-github] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-github-authorization]:not([hidden])');
    check(await page.eval(() => document.querySelector('[data-github-code]').textContent === 'ABCD-EFGH'), 'Device code missing');
    check(await page.eval(() => document.querySelector('[data-github-link]').href === location.origin + '/login/device'), 'Wrong verification URL');
    await page.wait('[data-connect-github] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.body.innerText.includes('Connected account: synthetic-machine')), 'Connected identity missing');
    check(await page.eval(() => !document.body.innerHTML.includes('gho_CANARY-browser-device')), 'Token was exposed');
    const revision = await page.eval(() => document.querySelector('[data-connect-github] [name=expectedRevision]').value);
    await page.eval(() => {
      const originalFetch = window.fetch.bind(window);
      let releasePoll;
      window.fetch = async (url, options) => {
        if (url === '/v1/admin/tools/gh-axi/device/poll') {
          document.body.dataset.githubPoll = 'waiting';
          return new Promise(resolve => { releasePoll = resolve; });
        }
        const response = await originalFetch(url, options);
        if (url === '/v1/admin/tools/gh-axi/device/cancel') {
          document.body.dataset.githubCancel = String(response.status);
          releasePoll(new Response(JSON.stringify({ status: 'connected' }), { status: 200 }));
        }
        return response;
      };
    });
    await page.click('[data-connect-github] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-github-authorization]:not([hidden])');
    await page.wait('body[data-github-poll="waiting"]');
    await page.click('[data-cancel-github]');
    await page.wait('body[data-github-cancel="200"] [data-cancel-github]:disabled');
    check(await page.eval(() => document.querySelector('[data-github-status]').textContent.includes('Connection cancelled.')), 'Cancellation not confirmed');
    check(await page.eval(() => document.querySelector('[data-connect-github] [name=expectedRevision]').value) === revision, 'Cancel replaced credential');
  `)
})

test('user detail designates a break-glass administrator and removing it signs them out', () => {
  browser(`await page.open(base + '/admin/users/synthetic-development-user');
    await page.wait('form[action="/v1/admin/users/synthetic-development-user"] [name=breakGlass]');
    await page.click('form:has([name=breakGlass]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=breakGlass][value=false])');
    check(await page.eval(() => document.querySelector('.account-menu summary').innerText.includes('Break-glass')), 'Designation was not shown');
    await page.click('form:has([name=breakGlass]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/login"]');
    await page.open(base + '/admin');
    await page.wait('form[action="/login"]');`)
})

test('invitations show each new link once and allow resend and revoke through the real forms', async () => {
  browser(`
    await page.open(base + '/admin/settings/sign-in');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('a[href^="/admin/settings/sign-in/"]');
    await page.open(base + '/admin');
    await page.click('a[href="/admin/invitations"]');
    await page.wait('form[data-invitation-link]');
    await page.fill('[name=displayName]', 'Synthetic invited user');
    await page.fill('[name=expectedUsername]', 'synthetic@identity.example');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[data-invitation-link] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#invitation-link[open]');
    const first = await page.eval(() => document.querySelector('[data-claim-link]').value);
    check(first.startsWith(base + '/auth/sso/'), 'Invitation was not a link for this server');
    await page.click('#invitation-link button');
    await page.wait('details[data-invitation]');
    check(await page.eval(() => document.querySelector('[data-claim-link]').value === ''), 'Old link was redisplayed');
    await page.click('details[data-invitation] > summary');
    check(await page.eval(() => document.querySelector('details[data-invitation]').innerText.includes('Synthetic Role')), 'Direct role was not retained');
    await page.click('form[action$="/resend"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#invitation-link[open]');
    const second = await page.eval(() => document.querySelector('[data-claim-link]').value);
    check(second !== first, 'Resend reused the old link');
    await page.click('#invitation-link button');
    await page.wait('details[data-invitation]');
    await page.click('details[data-invitation] > summary');
    await page.click('form[action$="/revoke"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('details[data-invitation] > summary');
    await page.wait('details[data-invitation]:not(:has(form))');
    check(await page.eval(() => document.querySelector('details[data-invitation] > summary').innerText.includes('revoked')), 'Invitation was not revoked');
    check(await page.eval(async () => (await (await fetch('/v1/admin/sso/providers')).json()).providers.every(provider => !provider.enabled)), 'Invitations enabled SSO');
  `)
})

test('invitations link an existing local user through its detail page and recent-auth confirmation', async () => {
  browser(`
    await page.open(base + '/admin/settings/sign-in');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('a[href^="/admin/settings/sign-in/"]');
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('a[href^="/admin/invitations?userId="]');
    await page.wait('[name=userId]');
    check(await page.eval(() => document.querySelector('[name=userId]').value === 'synthetic-ordinary'), 'Wrong account selected for linking');
    check(await page.eval(() => document.querySelector('[name=displayName]').value === 'Ordinary'), 'Display name was not prefilled');
    await page.fill('[name=expectedUsername]', 'synthetic@identity.example');
  `)
  await expireConfirmation()
  browser(`
    await page.click('form[data-invitation-link] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#reauth-dialog[open]');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-browser-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('#invitation-link[open]');
    await page.click('#invitation-link button');
    await page.wait('details[data-invitation]');
    const invitations = await page.eval(async () => (await (await fetch('/v1/admin/sso/invitations')).json()).invitations);
    check(invitations.length === 1 && invitations[0].userId === 'synthetic-ordinary', 'Link invitation did not bind the existing account');
    const user = await page.eval(async () => (await (await fetch('/v1/admin/users/synthetic-ordinary')).json()));
    check(user.source === 'local' && user.enabled, 'Preparing the link changed local access');
  `)
})

test('sign-in settings stores, edits and removes a rule through recent-auth confirmation', async () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/settings/sign-in');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tbody a');
    await page.click('tbody a');
    await page.wait('[name=roleId]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('No role rules')), 'Missing rule empty state');
    await page.fill('form[action="/v1/admin/sso/role-rules"] [name=value]', 'Artium.Readers');
    await page.fill('form[action="/v1/admin/sso/role-rules"] [name=roleId]', 'synthetic-role');
  `)
  await expireConfirmation()
  browser(`
    await page.click('form[action="/v1/admin/sso/role-rules"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#reauth-dialog[open]');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-browser-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('details:has(form[data-method=DELETE])');
    await page.click('details:has(form[data-method=DELETE]) > summary');
    check(await page.eval(() => document.querySelector('details:has(form[data-method=DELETE])').innerText.includes('falcon-axi')), 'Missing target tool access');
    await page.fill('details form[data-method=PATCH] [name=value]', 'Artium.Analysts');
    await page.click('details form[data-method=PATCH] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('details form[data-method=PATCH] [name=value][value="Artium.Analysts"]');
    await page.click('details:has(form[data-method=DELETE]) > summary');
    check(await page.eval(() => document.querySelector('details form[data-method=PATCH] [name=expectedRevision]').value === '2'), 'Rule revision did not advance');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Rule editor overflows at 420px');
    await page.click('details form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=cancel]');
    check(await page.eval(() => !!document.querySelector('details form[data-method=DELETE]')), 'Cancel removed the rule');
    await page.click('details form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('section:not(:has(form[data-method=DELETE])) > form[action="/v1/admin/sso/role-rules"]');
    check(await page.eval(() => !document.querySelector('details form[data-method=DELETE]') && document.querySelector('main').innerText.includes('No role rules')), 'Rule was not removed');
    check(await page.eval(async () => {
      const providers = (await (await fetch('/v1/admin/sso/providers')).json()).providers;
      const audit = (await (await fetch('/v1/admin/audit?event=admin-change')).json()).records;
      return providers[0].enabled === false && ['create-role-rule', 'update-role-rule', 'delete-role-rule'].every(action =>
        audit.filter(row => row.action === action && row.outcome === 'success').length === 1);
    }), 'Rule audit missing or provider enabled');
  `)
})

test('sign-in settings creates a disabled provider and saves a certificate without redisplaying its key', async () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.click('a.menu-open');
    await page.click('nav a[href="/admin/settings/sign-in"]');
    await page.wait('[name=tenantId]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('New providers start disabled')), 'Missing disabled-sign-in guidance');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tbody a');
    await page.click('tbody a');
    await page.wait('[data-certificate-pem]');
    check(await page.eval(() => !document.querySelector('form[action$="/activation"]') && document.querySelector('main').innerText.includes('Entra setup guide')), 'Activation offered before completing setup');
    check(await page.eval(() => document.querySelector('[data-profile-field=auth]').value === '"certificate"'), 'Certificate is not the default');
    await page.fill('[data-profile-field=clientId]', '22222222-2222-4222-8222-222222222222');
    await page.fill('[data-certificate-pem]', ${JSON.stringify(fixture.certificatePem)});
    await page.click('form[action$="/credential"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=privateKey]').value === '' && document.querySelector('[data-certificate-pem]').value === ''), 'Private key redisplayed');
    check(await page.eval(() => document.querySelector('[data-profile-field=thumbprintSha256]').value) === ${JSON.stringify(new X509Certificate(fixture.certificatePem).fingerprint256.replaceAll(':', '').toLowerCase())}, 'Incorrect fingerprint');
    await page.click('form[action$="/credential"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="2"]');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Settings page overflows at 420px');
    await page.fill('form:has([name=name]) [name=name]', 'Renamed provider');
    await page.click('form:has([name=name]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=name][value="Renamed provider"]');
    check(await page.eval(async () => {
      const providers = (await (await fetch('/v1/admin/sso/providers')).json()).providers;
      const credential = await (await fetch('/v1/admin/sso/providers/' + providers[0].id + '/credential')).json();
      const audit = await (await fetch('/v1/admin/audit?event=admin-change')).json();
      return providers[0].enabled === false && credential.configured && !JSON.stringify(credential).includes('PRIVATE KEY') &&
        audit.records.filter(row => row.action === 'replace-provider-credential' && row.outcome === 'success').length === 2 &&
        audit.records.some(row => row.action === 'update-provider' && row.outcome === 'success');
    }), 'Provider state or audit incorrect');
  `)
})

test('sign-in settings can save a client secret and requires a replacement when the client changes', () => {
  browser(`
    await page.open(base + '/admin/settings/sign-in');
    await page.fill('[name=name]', 'Synthetic secret provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tbody a');
    await page.click('tbody a');
    await page.wait('[data-profile-field=auth]');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"secret"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    check(await page.eval(() => document.querySelector('[data-certificate]').hidden && document.querySelector('main').innerText.includes('less secure than certificates')), 'Missing secret warning or conditional fields');
    await page.fill('[data-profile-field=clientId]', '22222222-2222-4222-8222-222222222222');
    await page.fill('[data-profile-field=clientSecret]', 'CANARY-provider-secret');
    await page.click('form[action$="/credential"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=clientSecret]').value === '' && !document.documentElement.outerHTML.includes('CANARY-provider-secret')), 'Secret redisplayed');
    await page.fill('[data-profile-field=clientId]', '33333333-3333-4333-8333-333333333333');
    check(await page.eval(() => document.querySelector('[data-profile-field=clientSecret]').required), 'Changed client does not require a replacement secret');
  `)
})

test('audit event filter, pagination and expanded details retain the selected search', async () => {
  assert.equal((await fetch(fixture.clock.replace('/test/clock', '/test/audit'), { method: 'POST' })).status, 200)
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/audit?limit=1');
    await page.eval(() => { const event = document.querySelector('[name=event]'); event.value = 'run-start'; event.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.wait('.filter.set [name=event]');
    check(await page.eval(() => document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').textContent.includes('run-start')), 'Event filter failed');
    check(await page.eval(() => [...document.querySelectorAll('thead th')].slice(3).every(cell => cell.getBoundingClientRect().width >= 80)), 'Tool and Outcome columns are too narrow to read');
    await page.click('tbody th a');
    await page.wait('#record');
    await page.click('#record .all-fields summary');
    check(await page.eval(() => document.querySelector('#record .all-fields').open && document.querySelector('#record dd').textContent), 'Record details did not open');
    check(await page.eval(() => document.querySelector('#record .all-fields dl').textContent.includes('synthetic-run-102') && document.querySelector('#record .all-fields dl').textContent.includes('[redacted]')), 'Safe details missing');
    check(await page.eval(() => document.querySelector('#record .all-fields dl').getBoundingClientRect().width >= 320), 'Expanded audit fields are too narrow to read');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded audit record overflows the narrow screen');
    await page.click('.card-foot a[href*="cursor="]');
    await page.wait('.card-foot a:not([href*="cursor="])');
    await page.click('tbody th a');
    await page.wait('#record');
    check(await page.eval(() => document.querySelector('[name=event]').value === 'run-start' && document.querySelector('#record .all-fields dl').textContent.includes('synthetic-run-101')), 'Older page lost the filter');
    await page.click('.card-foot a:not([href*="cursor="])');
    await page.wait('.card-foot span[aria-disabled]');
    await page.click('tbody th a');
    await page.wait('#record');
    check(await page.eval(() => document.querySelector('#record .all-fields dl').textContent.includes('synthetic-run-102')), 'Newest did not restart the search');
    await page.click('main a[href="/admin/audit"]');
    await page.wait('[name=event]');
    check(await page.eval(() => document.querySelector('[name=event]').value === ''), 'Clear filters failed');
    await page.open(base + '/admin/audit?failed=1&range=7d');
    await page.eval(() => { const tool = document.querySelector('[name=tool]'); tool.value = 'falcon-axi'; tool.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.wait('.filter.set [name=tool]');
    check(await page.eval(() => {
      const query = new URLSearchParams(location.search);
      return query.get('tool') === 'falcon-axi' && query.get('failed') === '1' && query.get('range') === '7d';
    }), 'Changing a dropdown lost the failed-run filter or time preset');
  `)
})

test('audit downloads export every filtered page with safe fields and explain their scope', async () => {
  assert.equal((await fetch(fixture.clock.replace('/test/clock', '/test/audit'), { method: 'POST' })).status, 200)
  browser(`
    await page.open(base + '/admin/audit?event=run-start&user=synthetic-ordinary&tool=falcon-axi&outcome=started&from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&limit=1');
    await page.click('a[href*="cursor="]');
    await page.wait('tbody tr');
    await page.click('.page-help summary');
    check(await page.eval(() => document.querySelector('.page-help').textContent.includes('across every page')), 'Missing export help');
    const result = await page.eval(async () => {
      const downloads = [];
      for (const link of document.querySelectorAll('a[download]')) {
        const response = await fetch(link.href);
        downloads.push({ text: await response.text(), status: response.status, disposition: response.headers.get('content-disposition') });
      }
      return downloads;
    });
    check(result.length === 2 && result.every(file => file.status === 200 && file.disposition.startsWith('attachment;')), 'Missing download response');
    check(result.every(file => !file.text.includes('CANARY-audit-secret') && file.text.includes('[redacted]')), 'Secret leaked in export');
    const records = result[1].text.trimEnd().split('\\n').map(line => JSON.parse(line));
    check(records.length === 103 && records.every(record => record.event === 'run-start' && record.user_id === 'synthetic-ordinary'), 'JSON-lines download was paginated or unfiltered');
    check(result[0].text.split('\\r\\n').length === 105 && result[0].text.startsWith('id,occurred_at,event,'), 'CSV download was paginated');
  `)
})

test('navigation exposes contextual help and one sign-out on every admin screen at desktop and narrow widths', () => {
  for (const width of [1280, 420]) {
    chrome(['resize', String(width), '900'])
    browser(`
    for (const path of ['/admin', '/admin/users/synthetic-ordinary', '/admin/roles', '/admin/roles/synthetic-role', '/admin/tools', '/admin/credentials', '/admin/tools/falcon-axi', '/admin/tools/vectra-axi', '/admin/tools/az-axi', '/admin/tools/mg-axi', '/admin/tools/ldap-axi', '/admin/audit', '/account', '/password', '/reauth']) {
      await page.open(base + path);
      await page.click('.page-help summary');
      check(await page.eval(() => document.querySelector('.page-help').open), 'Help did not open on ' + path);
      check(await page.eval(() => document.querySelectorAll('form[action="/logout"]').length === 1), 'Sign-out is missing or duplicated on ' + path);
      check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow on ' + path);
      check(await page.eval(() => document.querySelector('.account-menu summary').textContent.includes('Password')), 'Missing sign-in source on ' + path);
    }
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu a[href="/account"]');
    await page.wait('a[href="/password"]');
    check(await page.eval(() => location.pathname === '/account'), 'Account navigation failed');
    `)
  }
})

const toolCredentials = [
  { tool: 'falcon-axi', fields: { clientId: 'synthetic-client', clientSecret: 'CANARY-falcon-secret', region: 'us-1' }, secret: 'clientSecret', settings: {} },
  { tool: 'vectra-axi', fields: { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.example', auth: 'token', token: 'CANARY-vectra-token' }, secret: 'token', settings: { writes: { allowWrites: true, operations: ['notes.set'] } } },
  { tool: 'az-axi', fields: { tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222', auth: 'secret', clientSecret: 'CANARY-azure-secret' }, secret: 'clientSecret', settings: { description: 'Synthetic settings' } },
  { tool: 'mg-axi', fields: { mode: 'application', tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222', auth: 'client-secret', clientSecret: 'CANARY-graph-secret' }, secret: 'clientSecret', settings: { preview: true } },
  { tool: 'ldap-axi', fields: { url: 'ldaps://directory.example', auth: 'simple', bindDn: 'cn=reader,dc=example', bindPassword: 'CANARY-ldap-password' }, secret: 'bindPassword', settings: {} },
]

test('certificate inspection reviews the saved endpoint and trusts it in one confirmation', () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/tools/vectra-axi');
    for (const [name, value] of Object.entries({ kind: 'qux', apiVersion: '2.5', auth: 'token' })) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = ' + JSON.stringify(JSON.stringify(value)) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    await page.fill('[data-profile-field=origin]', base);
    await page.fill('[data-profile-field=token]', 'CANARY-certificate-review');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="1"]');
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
    await page.open(base + '/admin/tools/vectra-axi?tab=certificates');
    await page.wait('[data-inspect-certificate]:not([hidden])');
    await page.click('[data-inspect-certificate] button');
    await page.wait('#certificate-inspection[open]');
    check(await page.eval(() => document.querySelector('[data-certificate-details]').innerText.includes('Hostname: localhost')), 'Saved hostname missing');
    check(await page.eval(() => {
      const details = document.querySelector('[data-certificate-details]').innerText;
      return details.includes('Leaf expires: ' + ${JSON.stringify(new Date(new X509Certificate(fixture.certificatePem).validTo).toISOString())})
        && /Trust anchor expires: \\d{4}-\\d{2}-\\d{2}T/.test(details);
    }), 'Leaf or trust anchor expiry missing');
    check(await page.eval(() => {
      const warnings = [...document.querySelectorAll('[data-certificate-details] [role=alert]')].map(node => node.textContent);
      return warnings.some(text => text.startsWith('Leaf expires within seven days'))
        && warnings.some(text => text.startsWith('Trust anchor expires within seven days'));
    }), 'Short-lived leaf or anchor warning missing');
    check(await page.eval(() => document.querySelector('[data-certificate-details] input[readonly]').value) === ${JSON.stringify(new X509Certificate(fixture.certificatePem).fingerprint256)}, 'Incorrect full fingerprint');
    check(await page.eval(() => document.querySelector('#certificate-inspection').innerText.includes('interception')), 'Network-path warning missing');
    check(await page.eval(() => document.querySelector('[data-trust-certificate] [name=mode]').value === 'ca'), 'CA trust is not the default');
    check(await page.eval(() => document.querySelector('[data-trust-certificate] option[value=pin]').textContent.includes('Strict leaf pinning')), 'Strict pinning is unavailable');
    check(await page.eval(() => document.querySelector('#certificate-inspection').scrollWidth <= document.querySelector('#certificate-inspection').clientWidth), 'Certificate dialog overflows the narrow screen');
    await page.click('[data-trust-certificate] button');
    await page.wait('form[data-method=DELETE][action$="/certificates"]');
    await page.eval(async () => {
      // The reloaded form can appear before the stylesheet finishes loading.
      if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    });
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Trusted fingerprint overflows the narrow screen');
    check(await page.eval(() => !document.querySelector('#confirmation[open]')), 'Trust requires an extra confirmation');
    check(await page.eval(async () => {
      const result = await (await fetch('/v1/admin/tools/vectra-axi/certificates')).json();
      const audit = await (await fetch('/v1/admin/audit?event=admin-change')).json();
      return result.certificates.length === 1 && result.certificates[0].mode === 'ca' && audit.records.some(row => row.action === 'trust-certificate' && row.target_id === result.certificates[0].certificate.fingerprint);
    }), 'Trust or fingerprint audit missing');
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Test passed.'), 'Credential test did not pass after trust');
    await page.eval(async () => {
      const response = await fetch('/test/trust-ca', { method: 'POST' });
      if (!response.ok) throw new Error('Could not install the fixture CA');
    });
    await page.click('[data-inspect-certificate] button');
    await page.wait('#certificate-inspection[open]');
    check(await page.eval(() => document.querySelector('[data-certificate-details]').textContent.includes('No trust is needed')), 'Default trust was not explained');
    check(await page.eval(() => document.querySelector('[data-trust-certificate]').hidden), 'Already verified endpoint offers trust');
    await page.click('[data-close-certificate]');
    await page.click('form[data-method=DELETE][action$="/certificates"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-inspect-certificate][hidden]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('No certificates trusted')), 'Removed trust remains displayed');
  `)
})

test('credential diagnostics show the admission failure before saving', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form[data-test-tool] button');
    await page.wait('[data-check-diagnostic]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.includes('configuration')), 'Missing admission stage');
    check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.includes('No credential is configured for the tool.')), 'Missing admission diagnostic');
    check(await page.eval(() => document.querySelector('[data-check-error]').textContent === 'CREDENTIAL_NOT_CONFIGURED'), 'Missing current failure category');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Test failed.'), 'Missing failed test result');
  `)
})

test('disabled tool retains cached test outcomes after switching tabs', () => {
  browser(`
    await page.open(base + '/admin/tools/vectra-axi');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) [role=switch]').getAttribute('aria-checked') === 'false'), 'Tool must start disabled');
    for (const [name, value] of Object.entries({ kind: 'qux', apiVersion: '2.5', auth: 'token' })) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = ' + JSON.stringify(JSON.stringify(value)) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    await page.fill('[data-profile-field=origin]', base);
    await page.fill('[data-profile-field=token]', 'CANARY-cached-test');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-check-failure]:not([hidden]) [data-check-error]:not(:empty)');
    const error = await page.eval(() => document.querySelector('[data-check-error]').textContent);
    check(error === 'UPSTREAM_TLS_FAILED', 'Loopback fixture must fail on its untrusted certificate');
    const diagnostic = await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.trim());
    check(diagnostic.length > 0, 'Failure must explain the error');
    await page.click('nav.utabs a[href="?tab=access"]');
    await page.wait('nav.utabs a[href="?tab=access"][aria-current=page]');
    check(await page.eval(() => !document.querySelector('[data-check-failure]').hidden), 'Cached failure callout hidden after navigation');
    check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.trim()) === diagnostic, 'Cached diagnostic changed');
    check(await page.eval(() => document.querySelector('[data-check-summary]').textContent.trim().length > 0), 'Cached failure explanation missing');
    check(await page.eval(() => document.querySelector('[data-check-error]').textContent) === error, 'Cached failure category changed');
    check(await page.eval(() => document.querySelector('[data-tool-state]').textContent.includes('Failing')), 'Detail badge lost the failure');
    check(await page.eval(() => document.querySelector('[data-test-checklist]').textContent.includes('Failing:')), 'Setup lost the failed outcome');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) [role=switch]').getAttribute('aria-checked') === 'false'), 'Testing enabled the tool');
    await page.open(base + '/admin/tools');
    await page.wait('tbody a[href="/admin/tools/vectra-axi"]');
    check(await page.eval(() => document.querySelector('tbody a[href="/admin/tools/vectra-axi"]').closest('tr').querySelector('[data-label=State]').textContent.includes('Failing')), 'List lost the failed outcome');
    await page.open(base + '/admin/tools?show=attention');
    await page.wait('tbody a[href="/admin/tools/vectra-axi"]');
    check(await page.eval(() => document.querySelector('tbody a[href="/admin/tools/vectra-axi"]').closest('tr').querySelector('[data-label=State]').textContent.includes('Failing')), 'Needs attention lost the failed disabled tool');
    await page.eval(async () => {
      const response = await fetch('/test/trust-ca', { method: 'POST' });
      if (!response.ok) throw new Error('Could not install the fixture CA');
    });
    await page.open(base + '/admin/tools/vectra-axi');
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Test passed.'), 'Loopback test did not pass after trust');
    await page.click('nav.utabs a[href="?tab=access"]');
    await page.wait('nav.utabs a[href="?tab=access"][aria-current=page]');
    check(await page.eval(() => document.querySelector('[data-tool-state]').textContent.includes('Healthy')), 'Detail lost the successful outcome');
    check(await page.eval(() => document.querySelector('[data-check-failure]').hidden), 'Successful test retained the failure callout');
    check(await page.eval(() => document.querySelector('[data-test-checklist]').textContent.includes('Passed')), 'Setup lost the successful outcome');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) [role=switch]').getAttribute('aria-checked') === 'false'), 'Successful test enabled the tool');
    await page.open(base + '/admin/tools');
    await page.wait('tbody a[href="/admin/tools/vectra-axi"]');
    check(await page.eval(() => document.querySelector('tbody a[href="/admin/tools/vectra-axi"]').closest('tr').querySelector('[data-label=State]').textContent.includes('Healthy')), 'List lost the successful outcome');
  `)
})

for (const action of ['save', 'test']) {
  test('credential diagnostics retain the current ' + action + ' response over cached health', () => {
    browser(`
      await page.open(base + '/admin/tools/falcon-axi');
      await page.eval(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (url, options) => {
          if (new URL(url, location.href).pathname !== '/v1/admin/tools/falcon-axi/test') return original(url, options);
          return Response.json({ error: { code: 'TOO_MANY_CALLS', message: 'A check is already running.', next: 'Try again later.',
            diagnostic: { stage: 'configuration', message: 'This credential check was not admitted.', checkedAt: 1700000000000,
              credentialRevision: 1 } } }, { status: 429 });
        };
      });
      if (${JSON.stringify(action)} === 'save') {
        await page.fill('[data-profile-field="clientId"]', 'CANARY-falcon-client');
        await page.fill('[data-profile-field="clientSecret"]', 'CANARY-falcon-secret');
        await page.fill('[data-profile-field="region"]', 'us-1');
        await page.click('form[data-save-tool] button');
        await page.wait('#confirmation[open]');
        await page.click('#confirmation button[value=confirmed]');
      } else {
        await page.click('form[data-test-tool] button');
      }
      await page.wait('[data-check-diagnostic]:not(:empty)');
      check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent === 'configuration\\nThis credential check was not admitted.'), 'Current test diagnostic was replaced');
      check(await page.eval(() => document.querySelector('[data-check-error]').textContent === 'TOO_MANY_CALLS'), 'Current test category was replaced');
      check(await page.eval(() => document.querySelector('[data-check-time]').title === '2023-11-14T22:13:20.000Z'), 'Current test time was replaced');
      check(await page.eval(() => document.querySelector('[data-test-checklist] [data-step-state]').textContent === 'Failed: '), 'Failed test marked the checklist complete');
      check(await page.eval(() => !document.querySelector('[data-check-failure]').hidden), 'Failure callout hidden');
    `)
  })
}

for (const action of ['save', 'test']) {
  for (const outcome of ['redirect', 'html', 'invalid-health', 'ok']) {
    test(action + ' credential test validates ' + outcome + ' response', () => {
      browser(`
        await page.open(base + '/admin/tools/falcon-axi');
        await page.wait('[data-credential-editor]');
        await page.eval(() => {
          const original = window.fetch.bind(window);
          window.fetch = async (url, options) => {
            if (new URL(url, location.href).pathname !== '/v1/admin/tools/falcon-axi/test') return original(url, options);
            const outcome = ${JSON.stringify(outcome)};
            if (outcome === 'redirect') {
              // Revoke without clearing cookies so the test request receives a browser redirect.
              const revoked = await original('/v1/account/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ _csrf: document.querySelector('form[data-test-tool] [name=_csrf]').value }) });
              if (!revoked.ok) throw new Error('Could not revoke the browser session');
              const response = await original(url, options);
              if (!response.redirected) throw new Error('Expected a browser sign-in redirect');
              return response;
            }
            if (outcome === 'html') return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
            return Response.json(outcome === 'ok'
              ? { status: 'ok', checkedAt: Date.now(), credentialRevision: 1, errorCode: null }
              : { status: 'unknown', checkedAt: null, credentialRevision: null, errorCode: null });
          };
        });
        if (${JSON.stringify(action)} === 'save') {
          await page.fill('[data-profile-field="clientId"]', 'CANARY-falcon-client');
          await page.fill('[data-profile-field="clientSecret"]', 'CANARY-falcon-secret');
          await page.fill('[data-profile-field="region"]', 'us-1');
          await page.click('form[data-save-tool] button');
          await page.wait('#confirmation[open]');
          await page.click('#confirmation button[value=confirmed]');
        } else {
          await page.click('form[data-test-tool] button');
        }
        if (${JSON.stringify(outcome)} === 'redirect') {
          await page.wait('form[action="/login"]');
          check(await page.eval(() => sessionStorage.getItem('credential-test:/admin/tools/falcon-axi') === null), 'Redirect retained a success result');
        } else if (${JSON.stringify(action)} === 'save') {
          await page.wait('[data-test-result]:not(:empty)');
          const expected = ${JSON.stringify(outcome === 'ok' ? 'Saved. Test passed.' : 'Saved. Test could not complete. Run Test connection again.')};
          check(await page.eval(() => document.querySelector('[data-test-result]').textContent) === expected, 'Incorrect save-and-test result');
        } else if (${JSON.stringify(outcome)} === 'ok') {
          await page.wait('[data-test-result]:not(:empty)');
          check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Test passed.'), 'Valid health was rejected');
        } else {
          await page.wait('#message:not(:empty)');
          check(await page.eval(() => document.querySelector('[data-test-result]').textContent === ''), 'Invalid health reported success');
        }
      `);
    });
  }
}

test('Graph federated authentication hides incompatible fields before entering a token', () => {
  browser(`
    await page.open(base + '/admin/tools/mg-axi');
    await page.eval(() => {
      for (const [name, value] of [['mode', 'delegated'], ['mode', 'application'], ['auth', 'federated']]) {
        const input = document.querySelector('[data-profile-field=' + name + ']');
        input.value = JSON.stringify(value);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    check(await page.eval(() => {
      const token = document.querySelector('[data-profile-field=token]');
      return token.value === '' && !token.disabled && token.required && !token.closest('[data-credential-field]').hidden;
    }), 'Federated token must be available and required while blank');
    for (const name of ['privateKey', 'clientSecret', 'thumbprintSha256']) {
      check(await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field=' + name + ']') + '); return input.disabled && input.closest("[data-credential-field]").hidden; })()'), name + ' remained visible or enabled');
    }
  `)
})

for (const entry of toolCredentials) test(entry.tool + ' guided credential save keeps secrets and native settings and tests inline', async () => {
  browser(`
    await page.open(base + '/admin/tools');
    await page.click('tbody a[href="/admin/tools/${entry.tool}"]');
    await page.wait('[data-credential-editor]');
    check(await page.eval(() => ['Write permissions', 'Certificates', 'Access', 'Advanced'].every(tab => [...document.querySelectorAll('nav.utabs a')].some(link => link.textContent.includes(tab)))), 'Tool tabs missing');
    await page.open(base + '/admin/tools/${entry.tool}?tab=advanced');
    await page.fill('[name=nativeSettings]', ${JSON.stringify(JSON.stringify(entry.settings))});
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=nativeSettings]) [name=expectedRevision][value="2"]');
    await page.open(base + '/admin/tools/${entry.tool}');
    await page.wait('form[data-save-tool] [name=expectedToolRevision][value="2"]');
    const fields = ${JSON.stringify(entry.fields)};
    for (const [name, value] of Object.entries(fields)) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = input.tagName === "SELECT" ? ' + JSON.stringify(JSON.stringify(value)) + ' : ' + JSON.stringify(value) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    check(await page.eval(() => document.querySelector('[data-save-and-test]').checked), 'Test after saving is not on by default');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Saved. Test passed.'), 'Save and test failed');
    check(await page.eval(() => document.querySelector('[data-profile-field="${entry.secret}"]').value === ''), 'Stored secret was displayed');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('[data-profile-field="${entry.secret}"]').value === ''), 'Retained secret was displayed');
    await page.open(base + '/admin/tools/${entry.tool}?tab=advanced');
    await page.fill('[name=nativeSettings]', ${JSON.stringify(JSON.stringify(entry.settings))});
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=nativeSettings]) [name=expectedRevision][value="5"]');
  `)
  const response = await fetch(fixture.clock.replace('/test/clock', '/test/tools/' + entry.tool))
  const { stored } = await response.json()
  assert.equal(stored[entry.secret], entry.fields[entry.secret])
  browser(`check(await page.eval(() => JSON.stringify(JSON.parse(document.querySelector('[name=nativeSettings]').value))) === ${JSON.stringify(JSON.stringify(entry.settings))}, 'Credential save changed native settings');`)
})

for (const saveAndTest of [false, true]) {
test('credential save' + (saveAndTest ? ' and test' : '') + ' shows normalization notices and canonical public values after reload', () => {
  browser(`
    await page.open(base + '/admin/tools/vectra-axi');
    await page.eval(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (new URL(url, location.href).pathname !== '/v1/admin/tools/vectra-axi/test') return original(url, options);
        return Response.json({ error: { code: 'UPSTREAM_NETWORK_FAILED', message: 'The upstream service could not be reached.',
          next: 'Check the diagnostic host and stage.', diagnostic: { stage: 'DNS', host: 'appliance.example',
            message: 'Synthetic DNS failure.', checkedAt: 1700000000000, credentialRevision: 1 } } }, { status: 503 });
      };
    });
    for (const [name, value] of Object.entries({ kind: 'qux', apiVersion: '2.5', auth: 'token' })) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = ' + JSON.stringify(JSON.stringify(value)) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    await page.fill('[data-profile-field=origin]', 'https://Appliance.Example:443/');
    await page.fill('[data-profile-field=token]', ' CANARY-normalized-token ');
    if (!${saveAndTest}) await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=origin]').value === 'https://appliance.example'), 'Stored canonical origin missing');
    check(await page.eval(() => document.querySelector('[data-profile-field=token]').value === ''), 'Stored secret was displayed');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.includes('origin: canonicalized format.')), 'Origin normalization notice missing');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.includes('token: removed surrounding whitespace.')), 'Secret normalization notice missing');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.startsWith(${JSON.stringify(saveAndTest ? 'Saved. Test failed.' : 'Saved.')})), 'Save result missing');
    if (${saveAndTest}) check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.includes('Synthetic DNS failure.')), 'Current diagnostic missing');
    check(await page.eval(() => !document.querySelector('main').innerText.includes('CANARY-normalized-token')), 'Secret appeared in notice');
  `)
})
}

test('LDAP CA PEM and multi-line secret keep exact newlines from browser to stored credential and delivered files', async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nCANARY-first-line\nCANARY-second-line\n-----END CERTIFICATE-----\n'
  const password = 'CANARY-first-line\nCANARY-second-line\n'
  browser(`
    await page.open(base + '/admin/tools/ldap-axi');
    await page.fill('[data-profile-field=url]', 'ldaps://directory.example');
    await page.eval(() => { const auth = document.querySelector('[data-profile-field=auth]'); auth.value = '"simple"'; auth.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.fill('[data-profile-field=bindDn]', 'cn=reader,dc=example');
    await page.fill('textarea[data-profile-field=bindPassword]', ${JSON.stringify(password)});
    await page.fill('textarea[data-profile-field=caFile]', ${JSON.stringify(pem)});
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Saved. Test passed.'), 'LDAP test failed: ' + await page.eval(() => document.querySelector('[data-test-result]').textContent));
    check(await page.eval(() => document.querySelector('[data-profile-field=caFile]').value) === ${JSON.stringify(pem)}, 'PEM was not pre-filled exactly');
  `)
  const { stored, delivered } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/ldap-axi'))).json()
  assert.equal(stored.caFile, pem)
  assert.equal(stored.bindPassword, password)
  assert.equal(delivered.caFile, pem)
  assert.equal(delivered.bindPassword, password)
})

for (const tool of ['az-axi', 'mg-axi']) test(tool + ' certificate PEM calculates the fingerprint and saves the matching key', async () => {
  browser(`
    await page.open(base + '/admin/tools/${tool}');
    ${tool === 'mg-axi' ? `await page.eval(() => { const input = document.querySelector('[data-profile-field=mode]'); input.value = '"application"'; input.dispatchEvent(new Event('change', { bubbles: true })); });` : ''}
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"certificate"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    check(await page.eval(() => document.querySelector('[data-profile-field=clientSecret]').disabled), 'Client secret remained active');
    await page.fill('[data-profile-field=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.fill('[data-profile-field=clientId]', '22222222-2222-4222-8222-222222222222');
    await page.eval('(() => { const transfer = new DataTransfer(); transfer.items.add(new File([' + ${JSON.stringify(JSON.stringify(fixture.certificatePem))} + '], "synthetic-identity.pem", { type: "application/x-pem-file" })); const input = document.querySelector("[data-certificate-file]"); input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await page.wait('[data-profile-field=privateKey]:not([required])');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=privateKey]').value === ''), 'Private key exposed');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/' + tool))).json()
  const certificate = new X509Certificate(fixture.certificatePem)
  assert.equal(stored.thumbprintSha256, certificate.fingerprint256.replaceAll(':', '').toLowerCase())
  assert.equal(stored.privateKey, fixture.certificatePem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/)[0] + '\n')
})

test('malformed certificate PEM keeps the draft and leaves the credential unconfigured', async () => {
  browser(`
    await page.open(base + '/admin/tools/az-axi');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"certificate"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.fill('[data-profile-field=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.fill('[data-profile-field=clientId]', '22222222-2222-4222-8222-222222222222');
    await page.fill('[data-certificate-pem]', 'CANARY-invalid-pem');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('#message:not(:empty)');
    check(await page.eval(() => document.querySelector('#message').textContent.includes('INVALID_INPUT')), 'Missing PEM error');
    check(await page.eval(() => document.querySelector('[data-certificate-pem]').value === 'CANARY-invalid-pem'), 'PEM draft lost');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/az-axi'))).json()
  assert.equal(stored, null)
})

test('tool detail enablement and granting roles lead to the role access editor', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=true]');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) [role=switch]').getAttribute('aria-checked') === 'false'), 'Switch does not show the disabled state');
    await page.click('nav.utabs a[href="?tab=access"]');
    await page.click('a[href="/admin/roles/synthetic-role"]');
    await page.wait('[name=tools][value="falcon-axi"]');
    check(await page.eval(() => document.querySelector('[name=tools][value="falcon-axi"]').checked), 'Role did not grant the tool');
  `)
})

test('tools show capability and current write state including fixed read-only reasons', () => {
  browser(`
    await page.open(base + '/admin/tools');
    const tools = await page.eval(async () => (await (await fetch('/v1/admin/tools')).json()).tools);
    for (const tool of tools) {
      const row = await page.eval('document.querySelector(' + JSON.stringify('a[href="/admin/tools/' + tool.name + '"]') + ').closest("tr").innerText');
      check(row.includes(tool.writeAccess.capable ? 'Read-only' : 'Always read-only'), tool.name + ' write state missing');
      await page.open(base + '/admin/tools/' + tool.name + '?tab=writes');
      await page.wait('[data-write-access]');
      const state = await page.eval(() => document.querySelector('[data-write-access]').innerText);
      check(state.includes(tool.writeAccess.blocked), tool.name + ' blocked actions missing');
      check(state.includes('currently granted.'), tool.name + ' current grant missing');
      check(await page.eval(() => Boolean(document.querySelector('form[action$="/write-access"]'))) === tool.writeAccess.capable, tool.name + ' incorrect switch availability');
      if (tool.writeAccess.reason) check(state.includes(tool.writeAccess.reason), tool.name + ' detail reason missing');
      await page.open(base + '/admin/tools');
    }
  `)
})

test('Falcon write switch offers separate RTR and MalQuery capabilities off by default', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi?tab=writes');
    await page.wait('[data-write-access]');
    check(await page.eval(() => Boolean(document.querySelector('[name=operations][value="rtr run"]'))), 'RTR capability missing');
    check(await page.eval(() => Boolean(document.querySelector('[name=operations][value="malquery search"]'))), 'MalQuery capability missing');
    check(await page.eval(() => !document.querySelector('[data-write-access] [name=enabled]').checked), 'Falcon writes enabled by default');
    check(await page.eval(() => !document.querySelector('[name=operations][value="malquery search"]').checked), 'MalQuery selected by default');
  `)
})

test('write switch confirms identity, preserves native settings, refreshes JSON and audits on and off', async () => {
  browser(`
    await page.open(base + '/admin/tools/az-axi?tab=advanced');
    check(await page.eval(() => document.body.innerText.includes('Omitting write settings turns writes off.')), 'JSON replacement warning missing');
    await page.fill('[name=nativeSettings]', JSON.stringify({ description: 'Synthetic scope', subscriptions: ['11111111-1111-4111-8111-111111111111'] }));
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=nativeSettings]) [name=expectedRevision][value="2"]');
    await page.open(base + '/admin/tools/az-axi?tab=writes');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="2"]');
    check(await page.eval(() => !document.querySelector('[data-write-access] [role=switch]').checked), 'Writes did not default off');
  `)
  await expireConfirmation()
  browser(`
    await page.click('[data-write-access] [role=switch]');
    await page.click('form[action$="/write-access"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=cancel]');
    check(await page.eval(async () => !(await (await fetch('/v1/admin/tools/az-axi')).json()).writeAccess.enabled), 'Cancel changed writes');
    await page.click('form[action$="/write-access"] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('#reauth-dialog[open]');
    check(await page.eval(async () => !(await (await fetch('/v1/admin/tools/az-axi')).json()).writeAccess.enabled), 'Writes bypassed identity confirmation');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-browser-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="3"]');
    check(await page.eval(() => document.querySelector('[data-write-access] [role=switch]').checked), 'Switch not on');
    check(await page.eval(() => document.querySelector('[data-write-access]').innerText.includes('Reviewed Azure writes')), 'Grant summary missing');
    await page.open(base + '/admin/tools/az-axi?tab=advanced');
    check(await page.eval(() => JSON.parse(document.querySelector('[name=nativeSettings]').value).allowWrites), 'JSON state stale');
    await page.open(base + '/admin/tools/az-axi?tab=writes');
    await page.click('[data-write-access] [role=switch]');
    await page.click('form[action$="/write-access"] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="4"]');
    const tool = await page.eval(async () => (await (await fetch('/v1/admin/tools/az-axi')).json()));
    check(!tool.writeAccess.enabled && tool.nativeSettings.allowWrites === false, 'Writes not off');
    check(tool.nativeSettings.description === 'Synthetic scope' && tool.nativeSettings.subscriptions[0] === '11111111-1111-4111-8111-111111111111', 'Other settings lost');
    const audit = await page.eval(async () => (await (await fetch('/v1/admin/audit?event=tool-write-access')).json()));
    check(audit.records.length === 2 && audit.records.every(event => event.tool === 'az-axi'), 'Dedicated audit events missing');
    check(!JSON.stringify(audit).includes('CANARY-'), 'Audit contains secret material');
  `)
})

for (const tool of ['mg-axi', 'vectra-axi']) test(tool + ' operation picker matches the pinned catalogue and saves the selection', () => {
  browser(`
    await page.open(base + '/admin/tools/${tool}?tab=writes');
    const initial = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    const choices = await page.eval(() => [...document.querySelectorAll('[name=operations]')].map(input => input.value));
    check(JSON.stringify([...choices].sort()) === JSON.stringify([...initial.writeAccess.supportedOperations].sort()), 'Picker differs from pinned catalogue');
    check(await page.eval(() => [...document.querySelectorAll('[name=operations]')].every(input => !input.checked)), 'Unexpected initial selection');
    await page.click('[data-write-access] [role=switch]');
    await page.click('form[action$="/write-access"] button:not([form])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('#message:not(:empty)');
    check(await page.eval(() => document.querySelector('#message').innerText.includes('Select at least one')), 'Empty enabled allow-list accepted');
    await page.click('[name=operations]');
    await page.click('form[action$="/write-access"] button:not([form])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="2"]');
    const saved = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    check(saved.writeAccess.enabled && JSON.stringify(saved.writeAccess.allowedOperations) === JSON.stringify([choices[0]]), 'Selection not saved');
    check(await page.eval(() => document.querySelector('[name=operations]').checked), 'Selection not reflected');
    check(await page.eval(() => document.querySelector('[data-ops-group]').open), 'Group with a selection is collapsed');
    await page.click('[data-write-access] [role=switch]');
    await page.click('[name=operations]');
    await page.click('form[action$="/write-access"] button:not([form])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="3"]');
    const cleared = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    check(!cleared.writeAccess.enabled && cleared.writeAccess.allowedOperations.length === 0, 'Empty selection not saved');
  `)
})

test('changing Vectra authentication requires new secrets and saves only the selected method', async () => {
  browser(`
    await page.open(base + '/admin/tools/vectra-axi');
    for (const [name, value] of Object.entries({ kind: 'qux', apiVersion: '2.5', auth: 'token' })) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = ' + JSON.stringify(JSON.stringify(value)) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    await page.fill('[data-profile-field=origin]', 'https://appliance.example');
    await page.fill('[data-profile-field=token]', 'CANARY-original-token');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="1"]');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"oauth"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('[data-save-and-test]');
    check(await page.eval(() => document.querySelector('[data-profile-field=token]').disabled), 'Old token remains active');
    check(await page.eval(() => document.querySelector('[data-profile-field=clientSecret]').required), 'New secret is not required');
    await page.click('form[data-save-tool] button');
    check(await page.eval(() => !document.querySelector('#confirmation').open), 'Empty new secret passed validation');
    await page.fill('[data-profile-field=clientId]', 'synthetic-oauth-client');
    await page.fill('[data-profile-field=clientSecret]', 'CANARY-new-oauth-secret');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/vectra-axi'))).json()
  assert.equal(stored.auth, 'oauth')
  assert.equal(stored.clientSecret, 'CANARY-new-oauth-secret')
  assert.equal(Object.hasOwn(stored, 'token'), false)
})

test('expired confirmation resumes the populated action exactly once after a wrong password is corrected', async () => {
  await expireConfirmation()
  browser(`
    await page.open(base + '/admin/roles?dialog=new-role');
    await page.wait('#new-role[open]');
    await page.fill('form[action="/v1/admin/roles"] [name=name]', 'Synthetic resumed role');
    await page.click('form[action="/v1/admin/roles"] button');
    await page.wait('#reauth-dialog[open]');
    check(await page.eval(() => location.pathname === '/admin/roles'), 'Reauth navigated away');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-wrong-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('#reauth-dialog [data-reauth-error]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-reauth-error]').innerText.includes('SIGN_IN_FAILED')), 'Missing error code');
    check(await page.eval(() => document.querySelector('form[action="/v1/admin/roles"] [name=name]').value === 'Synthetic resumed role'), 'Draft was lost');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-browser-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('form[action$="/tools"]');
    check(await page.eval(() => document.querySelector('h1').innerText === 'Synthetic resumed role'), 'Pending role was not created');
    check(await page.eval(() => document.querySelector('[data-reauth-until]').innerText.includes('Changes unlocked')), 'Confirmation window was not refreshed');
    check(await page.eval(async () => {
      const { records } = await (await fetch('/v1/admin/audit')).json();
      return records.filter(record => record.action === 'create-role').length === 1;
    }), 'Pending mutation ran more than once');
  `)
})

test('cancelled reauth preserves the draft and does not create a role', async () => {
  await expireConfirmation()
  browser(`
    await page.open(base + '/admin/roles');
    await page.click('.page-head [data-open-dialog=new-role]');
    await page.fill('form[action="/v1/admin/roles"] [name=name]', 'Synthetic cancelled role');
    await page.click('form[action="/v1/admin/roles"] button');
    await page.wait('#reauth-dialog[open]');
    await page.click('[data-reauth-cancel]');
    await page.wait('#reauth-dialog:not([open])');
    check(await page.eval(() => document.querySelector('form[action="/v1/admin/roles"] [name=name]').value === 'Synthetic cancelled role'), 'Cancelled draft was lost');
    check(await page.eval(async () => {
      const { roles } = await (await fetch('/v1/admin/roles')).json();
      return !roles.some(role => role.name === 'Synthetic cancelled role');
    }), 'Cancel submitted the mutation');
  `)
})

test('confirmation names the affected user and cancellation leaves the account enabled', () => {
  browser(`
    await page.click('a[href="/admin/users/synthetic-ordinary"]');
    const selector = 'form[action="/v1/admin/users/synthetic-ordinary"]:has([name=enabled])';
    await page.click(selector + ' button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('synthetic-ordinary')), 'Missing confirmation target');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('all their browser and CLI sessions')), 'Missing consequence');
    await page.click('#confirmation button[value=cancel]');
    await page.wait('#confirmation:not([open])');
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Disable user'), 'Cancel changed enabled state');
  `)
})

test('role rename saves without a dialog and stale drafts offer a reload recovery', () => {
  browser(`
    await page.open(base + '/admin/roles/synthetic-role');
    const selector = 'form[action="/v1/admin/roles/synthetic-role"]';
    await page.click('.inline-edit summary');
    await page.fill(selector + ' [name=name]', 'Synthetic renamed role');
    await page.click(selector + ' button');
    await page.wait('input[name=name][value="Synthetic renamed role"]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Synthetic renamed role'), 'Rename did not save');
    await page.eval(async () => {
      const form = document.querySelector('form[action="/v1/admin/roles/synthetic-role"]');
      const fields = new FormData(form);
      await fetch(form.action, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        _csrf: fields.get('_csrf'), name: 'Synthetic newer role', expectedRevision: Number(fields.get('expectedRevision')),
      }) });
    });
    await page.click('.inline-edit summary');
    await page.fill(selector + ' [name=name]', 'Synthetic stale role');
    await page.click(selector + ' button');
    await page.wait('#message button');
    check(await page.eval(() => document.getElementById('message').innerText.includes('REVISION_CONFLICT')), 'Missing stale-edit error');
    await page.click('#message button');
    await page.wait('input[name=name][value="Synthetic newer role"]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Synthetic newer role'), 'Reload did not recover current values');
  `)
})

test('account menu sign-out ends the browser session', () => {
  browser(`
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.open(base + '/admin');
    await page.wait('[name=username]');
    check(await page.eval(() => location.pathname === '/login'), 'Signed-out session still opens administration');
  `)
})

test('ordinary accounts have account help and no administration navigation', () => {
  browser(`
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('.account-menu');
    check(await page.eval(() => location.pathname === '/account'), 'Ordinary account did not open');
    check(await page.eval(() => !document.querySelector('nav[aria-label=Administration]')), 'Ordinary account has admin navigation');
    await page.click('.page-help summary');
    check(await page.eval(() => document.querySelector('.page-help').open), 'Missing account help');
  `)
})

test('user search combines filters, retains them through pagination and explains empty results', () => {
  browser(`
    await page.open(base + '/admin/users?limit=1');
    await page.fill('[name=q]', 'synthetic');
    await page.fill('[name=source]', 'local');
    await page.fill('[name=status]', 'enabled');
    await page.fill('[name=role]', 'synthetic-role');
    await page.click('form[data-filters] button');
    await page.wait('[name=q][value="synthetic"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('1 shown of 2 matching users')), 'Missing filtered count');
    await page.click('a[href*="cursor="]');
    await page.wait('a[href="/admin/users/synthetic-ordinary"]');
    check(await page.eval(() => ['q', 'source', 'status', 'role'].every(name => new URLSearchParams(location.search).has(name))), 'Pagination lost filters');
    await page.fill('[name=q]', 'no-matching-person');
    await page.click('form[data-filters] button');
    await page.wait('[name=q][value="no-matching-person"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('No matching users')), 'Missing empty-state guidance');
    check(await page.eval(() => !new URLSearchParams(location.search).has('cursor')), 'Search retained old cursor');
  `)
})

test('a local user can be created from the table and its profile edited from detail', () => {
  browser(`
    const create = 'form[action="/v1/admin/users"]';
    await page.fill(create + ' [name=username]', 'synthetic-new');
    await page.fill(create + ' [name=displayName]', 'New analyst');
    await page.fill(create + ' [name=temporaryPassword]', 'CANARY-temporary-password');
    await page.click(create + ' button');
    await page.wait('tbody a:not([href="/admin/users/synthetic-development-user"]):not([href="/admin/users/synthetic-ordinary"])');
    const href = await page.eval(() => [...document.querySelectorAll('tbody a')].find(link => link.textContent === 'synthetic-new').getAttribute('href'));
    await page.click('a[href="' + href + '"]');
    await page.wait('form[action="' + href.replace('/admin/', '/v1/admin/') + '"] [name=displayName]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Password change required')), 'New user did not require password change');
    await page.fill('[name=displayName]', 'Updated analyst');
    await page.click('[name=administrator]');
    await page.click('form:has([name=displayName]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=displayName][value="Updated analyst"]');
    check(await page.eval(() => document.querySelector('[name=administrator]').checked), 'Administrator edit was not saved');
    await page.click('main a[href="/admin/users"]');
    await page.wait('tbody');
    check(await page.eval(() => [...document.querySelectorAll('tbody tr')].some(row => row.innerText.includes('Updated analyst') && row.innerText.includes('Yes'))), 'Table did not reflect profile');
  `)
})

test('user detail can disable and re-enable sign-in', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=true]');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Enable user'), 'Disable was not saved');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Disable user'), 'Enable was not saved');
  `)
})

test('user detail unlock clears a lockout caused by failed sign-ins', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(fixture.clock.replace('/test/clock', '/v1/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic-ordinary', password: 'CANARY-wrong-password' }),
    })
    assert.equal(response.status, 401)
  }
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Failed sign-ins: 5')), 'Lockout was not shown');
    await page.click('form[action$="/unlock"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Failed sign-ins: 0')), 'Unlock did not clear attempts');
  `)
})

test('SSO user direct-role edits preserve rule access and offer no password reset', async () => {
  assert.equal((await fetch(fixture.clock.replace('/test/clock', '/test/sso'), { method: 'POST' })).status, 200)
  browser(`
    await page.open(base + '/admin/users?source=sso');
    check(await page.eval(() => document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').innerText.includes('SSO')), 'SSO source filter failed');
    await page.click('a[href="/admin/users/synthetic-sso"]');
    await page.wait('form[action$="/roles"]');
    check(await page.eval(() => !document.querySelector('form[action$="/password-reset"]')), 'SSO account offers a local password');
    check(await page.eval(() => !document.querySelector('[name=roleIds][type=checkbox]').checked), 'Rule grant was treated as a direct grant');
    check(await page.eval(() => document.querySelector('main').innerText.includes('(Rule)')), 'Rule access was not shown');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('falcon-axi') && document.querySelector('main').innerText.includes('(Rule)')), 'Saving empty direct roles removed rule access');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="3"]');
    check(await page.eval(() => document.querySelector('[name=roleIds][type=checkbox]').checked), 'Direct role was not saved alongside rule grant');
    check(await page.eval(() => document.querySelector('table caption').closest('table').innerText.includes('(Direct, Rule)')), 'Effective tools lost an overlapping grant origin');
    await page.open(base + '/admin/roles/synthetic-role');
    check(await page.eval(() => document.querySelector('a[href="/admin/users/synthetic-sso"]').closest('tr').innerText.match(/Direct|SSO rule/g).join() === 'Direct,SSO rule'), 'Role membership lost an overlapping grant origin');
    await page.open(base + '/admin/users/synthetic-sso');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="4"]');
    check(await page.eval(() => !document.querySelector('[name=roleIds][type=checkbox]').checked && document.querySelector('main').innerText.includes('(Rule)')), 'Removing direct role did not retain rule grant');
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/users"]');
    await page.open(base + '/admin/users/synthetic-sso');
    check(await page.eval(() => document.querySelector('main').innerText.includes('(Rule)') && document.querySelector('main').innerText.includes('No direct roles remain.') && !document.querySelector('main').innerText.includes('No retained roles remain.')), 'Archived user lost retained rule provenance');
  `)
})

test('user detail resets a password and the person must change it at sign-in', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('details:has(form[action$="/password-reset"]) summary');
    await page.fill('[name=temporaryPassword]', 'CANARY-reset-password');
    await page.click('form[action$="/password-reset"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Password change required')), 'Reset did not require password change');
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-reset-password');
    await page.click('button');
    await page.wait('[name=newPassword]');
    check(await page.eval(() => location.pathname === '/password'), 'Reset password did not open forced change');
  `)
})

test('R2: role creation errors stay accessible in the dialog and preserve the draft', () => {
  browser(`
    await page.open(base + '/admin/roles');
    const name = await page.eval(() => document.querySelector('tbody th a').textContent);
    await page.click('.page-head [data-open-dialog=new-role]');
    await page.fill('#new-role-name', name);
    await page.click('#new-role button');
    await page.wait('#new-role [data-form-error]:focus');
    check(await page.eval(() => document.querySelector('#new-role').matches(':modal') && document.activeElement.textContent.includes('INVALID_INPUT') && document.activeElement.getAttribute('role') === 'alert'), 'Duplicate-name error is inaccessible');
    check(await page.eval(() => document.querySelector('#new-role-name').value) === name, 'Duplicate-name error lost the draft');
    await page.eval(() => { window.fetch = async () => { throw new TypeError('Synthetic network failure'); }; });
    await page.click('#new-role button');
    await page.wait('#new-role [data-form-error]:focus');
    check(await page.eval(() => document.activeElement.textContent.includes('Request could not complete.')), 'Network error is inaccessible');
    check(await page.eval(() => document.querySelector('#new-role-name').value) === name, 'Network error lost the draft');
  `)
})

test('role tool grants and membership explain effective tools and an empty role can be deleted', () => {
  browser(`
    await page.open(base + '/admin/roles');
    await page.click('.page-head [data-open-dialog=new-role]');
    await page.fill('form[action="/v1/admin/roles"] [name=name]', 'Synthetic readers');
    await page.click('form[action="/v1/admin/roles"] button');
    await page.wait('[name=tools]');
    check(await page.eval(() => document.querySelector('h1').textContent === 'Synthetic readers'), 'New role did not open its page');
    const roleHref = await page.eval(() => location.pathname);
    await page.click('[name=tools][value="falcon-axi"]');
    await page.click('form:has([name=tools]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=tools]) [name=expectedRevision][value="2"]');
    await page.open(base + '/admin/users/synthetic-ordinary');
    const roleId = roleHref.split('/').pop();
    await page.click('[name=roleIds][value="' + roleId + '"]');
    await page.click('form:has([name=roleIds]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('td a[href="' + roleHref + '"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Direct')), 'Missing grant origin');
    await page.click('td a[href="' + roleHref + '"]');
    await page.wait('tbody a[href="/admin/users/synthetic-ordinary"]');
    check(await page.eval(() => !document.querySelector('form[data-method=DELETE]')), 'Nonempty role offered deletion');
    await page.click('tbody a[href="/admin/users/synthetic-ordinary"]');
    await page.wait('[name=roleIds]');
    await page.click('[name=roleIds][value="' + roleId + '"]');
    await page.click('form:has([name=roleIds]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=roleIds]) [name=expectedRevision][value="3"]');
    await page.open(base + roleHref);
    await page.click('form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('#confirmation button[value=confirmed]').disabled), 'Delete is enabled before the name is typed');
    await page.fill('[data-confirm-name-input]', 'Synthetic readers');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/roles"]');
    check(await page.eval(() => !document.querySelector('main').innerText.includes('Synthetic readers')), 'Deleted role remains in table');
  `)
})

async function cliSession(username = 'synthetic-ordinary', password = 'CANARY-local-password') {
  const response = await fetch(fixture.clock.replace('/test/clock', '/v1/auth/login'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('user detail revokes the selected CLI session while another session stays usable', async () => {
  const session = await cliSession()
  const second = await cliSession()
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('section:has(h2):has(table caption) form[action$="/revoke"] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('access and refresh tokens')), 'Missing revoke consequence');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('section:has(form[action$="/sessions/revoke"]) tbody tr:only-child');
  `)
  const responses = await Promise.all([session, second].map(tokens => fetch(fixture.clock.replace('/test/clock', '/v1/me'), {
    headers: { authorization: 'Bearer ' + tokens.accessToken },
  })))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401])
})

test('sign out everywhere on user detail ends the current browser and CLI sessions', async () => {
  const session = await cliSession('synthetic-user', 'CANARY-browser-password')
  browser(`
    await page.open(base + '/admin/users/synthetic-development-user');
    await page.click('form[action$="/sessions/revoke"] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('this browser')), 'Missing self sign-out consequence');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=username]');
    check(await page.eval(() => location.pathname === '/login'), 'Current browser was not signed out');
  `)
  const refresh = await fetch(fixture.clock.replace('/test/clock', '/v1/auth/refresh'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  assert.equal(refresh.status, 401)
})

test('archiving from detail hides the user and shows retained history when reopened', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(async () => {
      const _csrf = document.querySelector('form[action$="/archive"] [name=_csrf]').value;
      const response = await fetch('/v1/admin/roles', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _csrf, name: 'Synthetic unassigned role' }) });
      return response.ok;
    }), 'Could not create unassigned role');
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=cancel]');
    check(await page.eval(() => !!document.querySelector('form[action$="/archive"]')), 'Cancel changed the user');
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/users"]');
    check(await page.eval(() => !document.querySelector('tbody a[href="/admin/users/synthetic-ordinary"]')), 'Archived user remains in table');
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('main').innerText.includes('history is retained')), 'Archived state is missing');
    check(await page.eval(() => !document.querySelector('form:has([name=enabled])')), 'Archived detail offers enable');
    check(await page.eval(() => [...document.querySelectorAll('[name=roleIds][type=checkbox]')].every(input => input.value === 'synthetic-role')), 'Archived detail offers a new role');
    check(await page.eval(async () => {
      const { roles } = await (await fetch('/v1/admin/roles')).json();
      const id = roles.find(role => role.name === 'Synthetic unassigned role').id;
      const form = document.querySelector('form[action$="/roles"]');
      const fields = new FormData(form);
      const response = await fetch(form.action, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _csrf: fields.get('_csrf'), roleIds: [id], expectedRevision: Number(fields.get('expectedRevision')) }) });
      return response.status === 400 && (await response.json()).error.code === 'INVALID_INPUT';
    }), 'Archived role API accepted a new membership');
    await page.click('[name=roleIds][value="synthetic-role"]');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="3"]');
    check(await page.eval(() => !document.querySelector('[name=roleIds][value="synthetic-role"]')), 'Removed membership is still offered');
    check(await page.eval(async () => {
      const response = await fetch('/v1/admin/users/synthetic-ordinary');
      return (await response.json()).roleIds.length === 0;
    }), 'Retained membership could not be removed');
  `)
})

test('ordinary account shows role tools and usable CLI guidance and can revoke its current browser', () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('a[href="/cli/artium-axi.mjs"]');
    check(await page.eval(() => location.pathname === '/account'), 'Ordinary user did not reach account');
    check(await page.eval(() => {
      const text = document.querySelector('main').innerText;
      return text.includes('Live malware: this archive may contain executable malware. Save only; do not extract or execute. Password protection is unverified; bytes are saved exactly as provided.')
        && text.includes('artium-axi download --help') && text.includes('250 MiB')
        && text.includes('Missing verified-save receipt remains unconfirmed.')
        && !document.querySelector('a[href^="/v1/transfers/"]');
    }), 'Archive guidance lost its warning, limits, receipt distinction or CLI-only save boundary');
    check(await page.eval(() => document.querySelector('main').innerText.includes('falcon-axi')), 'Granted tools are missing');
    check(await page.eval(() => document.querySelector('pre').textContent.includes(location.origin)), 'CLI uses wrong server');
    check(await page.eval(() => document.querySelector('main').innerText.includes("login --username 'synthetic-ordinary'")), 'CLI username is missing');
    check(await page.eval(() => {
      const help = document.querySelector('.page-help').textContent;
      return help.includes('your local username') && help.includes('Change password') && !help.includes('login --sso');
    }), 'Local account help lost its username or password guidance');
    check(await page.eval(() => {
      const table = document.querySelector('section:has(form[action="/v1/account/sessions/revoke"]) table');
      const controls = [...table.querySelectorAll('time, button')];
      return controls.every(control => {
        const range = document.createRange();
        range.selectNodeContents(control);
        return range.getClientRects().length === 1;
      });
    }), 'Session dates or revoke controls wrap into fragments at 420px');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Session table overflows the page');
    await page.click('form[action^="/v1/account/sessions/"]:not([action="/v1/account/sessions/revoke"]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=username]');
    check(await page.eval(() => location.pathname === '/login'), 'Revoked browser retained access');
  `)
})
