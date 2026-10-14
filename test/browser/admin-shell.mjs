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
    await page.wait('form[action="/v1/admin/users"]');
  `)
})

afterEach(async () => {
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
      check(await page.eval(() => document.querySelector('header').innerText.includes('Local password sign-in')), 'Missing sign-in source on ' + path);
    }
    await page.click('a[href="/account"]');
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
              await original('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ _csrf: document.querySelector('form[data-test-tool] [name=_csrf]').value }) });
              return original(url, options);
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
          await page.click('[data-save-and-test]');
          await page.click('form[data-save-tool] button');
          await page.wait('#confirmation[open]');
          await page.click('#confirmation button[value=confirmed]');
        } else {
          await page.click('form[data-test-tool] button');
          await page.wait('#confirmation[open]');
          await page.click('#confirmation button[value=confirmed]');
        }
        if (${JSON.stringify(outcome)} === 'redirect') {
          await page.wait('form[action="/login"]');
          check(await page.eval(() => sessionStorage.getItem('credential-test:/admin/tools/falcon-axi') === null), 'Redirect retained a success result');
        } else if (${JSON.stringify(action)} === 'save') {
          await page.wait('[data-test-result]:not(:empty)');
          const expected = ${JSON.stringify(outcome === 'ok' ? 'Saved. Test passed.' : 'Saved. Test could not complete. Run Test credential again.')};
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

for (const entry of toolCredentials) test(entry.tool + ' guided credential save keeps secrets and native settings and tests inline', async () => {
  browser(`
    await page.open(base + '/admin/tools');
    await page.click('tbody a[href="/admin/tools/${entry.tool}"]');
    await page.wait('[data-credential-editor]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Native settings') && document.querySelector('main').innerText.includes('Access')), 'Merged tool sections missing');
    await page.fill('[name=nativeSettings]', ${JSON.stringify(JSON.stringify(entry.settings))});
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedToolRevision][value="2"]');
    const fields = ${JSON.stringify(entry.fields)};
    for (const [name, value] of Object.entries(fields)) {
      await page.eval('(() => { const input = document.querySelector(' + JSON.stringify('[data-profile-field="' + name + '"]') + '); input.value = input.tagName === "SELECT" ? ' + JSON.stringify(JSON.stringify(value)) + ' : ' + JSON.stringify(value) + '; input.dispatchEvent(new Event("change", { bubbles: true })); })()');
    }
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Saved. Test passed.'), 'Save and test failed');
    check(await page.eval(() => document.querySelector('[data-profile-field="${entry.secret}"]').value === ''), 'Stored secret was displayed');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('[data-profile-field="${entry.secret}"]').value === ''), 'Retained secret was displayed');
    await page.fill('[name=nativeSettings]', ${JSON.stringify(JSON.stringify(entry.settings))});
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedToolRevision][value="5"]');
  `)
  const response = await fetch(fixture.clock.replace('/test/clock', '/test/tools/' + entry.tool))
  const { stored } = await response.json()
  assert.equal(stored[entry.secret], entry.fields[entry.secret])
  browser(`check(await page.eval(() => JSON.stringify(JSON.parse(document.querySelector('[name=nativeSettings]').value))) === ${JSON.stringify(JSON.stringify(entry.settings))}, 'Credential save changed native settings');`)
})

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
    await page.click('[data-save-and-test]'); await page.click('form[data-save-tool] button');
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
    await page.click('a[href="/admin/roles/synthetic-role"]');
    await page.wait('[name=tools][value="falcon-axi"]');
    check(await page.eval(() => document.querySelector('[name=tools][value="falcon-axi"]').checked), 'Role did not grant the tool');
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
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="1"]');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"oauth"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
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
    await page.open(base + '/admin/roles');
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
    await page.wait('tbody a:not([href="/admin/roles/synthetic-role"])');
    check(await page.eval(() => [...document.querySelectorAll('tbody a')].some(link => link.textContent === 'Synthetic resumed role')), 'Pending role was not created');
    check(await page.eval(() => document.querySelector('[data-reauth-until]').innerText.includes('Changes allowed for')), 'Confirmation window was not refreshed');
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

test('confirmed changes use the same action and stale drafts offer a reload recovery', () => {
  browser(`
    await page.open(base + '/admin/roles/synthetic-role');
    const selector = 'form[action="/v1/admin/roles/synthetic-role"]';
    await page.fill(selector + ' [name=name]', 'Synthetic confirmed role');
    await page.click(selector + ' button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('input[name=name][value="Synthetic confirmed role"]');
    check(await page.eval(() => [...document.querySelectorAll('section h2')].some(title => title.textContent === 'Synthetic confirmed role')), 'Confirmation did not rename role');
    await page.eval(async () => {
      const form = document.querySelector('form[action="/v1/admin/roles/synthetic-role"]');
      const fields = new FormData(form);
      await fetch(form.action, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        _csrf: fields.get('_csrf'), name: 'Synthetic newer role', expectedRevision: Number(fields.get('expectedRevision')),
      }) });
    });
    await page.fill(selector + ' [name=name]', 'Synthetic stale role');
    await page.click(selector + ' button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#message button');
    check(await page.eval(() => document.getElementById('message').innerText.includes('REVISION_CONFLICT')), 'Missing stale-edit error');
    await page.click('#message button');
    await page.wait('input[name=name][value="Synthetic newer role"]');
    check(await page.eval(() => [...document.querySelectorAll('section h2')].some(title => title.textContent === 'Synthetic newer role')), 'Reload did not recover current values');
  `)
})

test('header sign-out ends the browser session', () => {
  browser(`
    await page.click('header form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.open(base + '/admin');
    await page.wait('[name=username]');
    check(await page.eval(() => location.pathname === '/login'), 'Signed-out session still opens administration');
  `)
})

test('ordinary accounts have account help and no administration navigation', () => {
  browser(`
    await page.click('header form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('nav[aria-label=Account]');
    check(await page.eval(() => location.pathname === '/account'), 'Ordinary account did not open');
    check(await page.eval(() => !document.querySelector('nav[aria-label=Administration]')), 'Ordinary account has admin navigation');
    await page.click('.page-help summary');
    check(await page.eval(() => document.querySelector('.page-help').open), 'Missing account help');
  `)
})

test('user search combines filters, retains them through pagination and explains empty results', () => {
  browser(`
    await page.open(base + '/admin?limit=1');
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
    await page.click('a[href="/admin"]');
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
    await page.click('header form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-reset-password');
    await page.click('button');
    await page.wait('[name=newPassword]');
    check(await page.eval(() => location.pathname === '/password'), 'Reset password did not open forced change');
  `)
})

test('role tool grants and membership explain effective tools and an empty role can be deleted', () => {
  browser(`
    await page.open(base + '/admin/roles');
    await page.fill('form[action="/v1/admin/roles"] [name=name]', 'Synthetic readers');
    await page.click('form[action="/v1/admin/roles"] button');
    await page.wait('tbody a:not([href="/admin/roles/synthetic-role"])');
    const roleHref = await page.eval(() => [...document.querySelectorAll('tbody a')].find(link => link.textContent === 'Synthetic readers').getAttribute('href'));
    await page.click('a[href="' + roleHref + '"]');
    await page.wait('[name=tools]');
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
    await page.click('header form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('a[href="/cli/artium-axi.mjs"]');
    check(await page.eval(() => location.pathname === '/account'), 'Ordinary user did not reach account');
    check(await page.eval(() => document.querySelector('main').innerText.includes('falcon-axi')), 'Granted tools are missing');
    check(await page.eval(() => document.querySelector('pre').textContent.includes(location.origin)), 'CLI uses wrong server');
    check(await page.eval(() => document.querySelector('main').innerText.includes("login --username 'synthetic-ordinary'")), 'CLI username is missing');
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
