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
    const openInstance = (tool, name = 'default') => page.open(base + '/admin/tools/' + tool + '/instances/' + name);
    const addInstance = async (tool, name = 'default') => {
      await page.open(base + '/admin/tools/' + tool + '?sheet=add-instance');
      await page.fill('[name=name]', name);
    };
    const createInstance = async (tool, value, name = 'default') => {
      await page.open(base + '/admin/tools/' + tool);
      const status = await page.eval('(async () => { const response = await fetch("/v1/admin/tools/' + tool + '/instances", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ name: "' + name + '", description: "", value: ' + JSON.stringify(value) + ', expectedToolRevision: Number(document.querySelector("[name=expectedToolRevision]").value), _csrf: document.querySelector("[name=_csrf]").value }) }); return response.status; })()');
      if (status !== 200) throw new Error('Could not create the ' + tool + ' instance: ' + status);
      await openInstance(tool, name);
    };
    const falconValue = { clientId: 'CANARY-falcon-client', clientSecret: 'CANARY-falcon-secret', region: 'us-1' };
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
  server = spawn(process.execPath, ['test/fake-service/browser-auth.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
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

test('administrators can disable and re-enable token creation', () => {
  browser(`
    await page.open(base + '/admin/tokens');
    check(await page.eval(() => document.querySelector('[name=mintingEnabled]').checked), 'Minting is not enabled by default');
    await page.click('[name=mintingEnabled]');
    await page.fill('[name=maxLifetimeHours]', '2');
    await page.click('form[data-token-settings] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=maxLifetimeHours][value="2"]');
    await page.open(base + '/account');
    check(await page.eval(() => !document.querySelector('form[data-create-token]')), 'Minting remained available');
    await page.open(base + '/admin/tokens');
    check(await page.eval(() => !document.querySelector('[name=mintingEnabled]').checked), 'Disabled setting was not saved');
    await page.click('[name=mintingEnabled]');
    await page.click('form[data-token-settings] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=mintingEnabled]:checked');
    await page.open(base + '/account');
    check(await page.eval(() => !!document.querySelector('form[data-create-token]')), 'Minting did not become available');
  `)
})

test('ordinary users can create temporary tokens after recent authentication expires', async () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    await page.open(base + '/admin#nav');
    await page.click('.account-menu summary');
    await page.click('.account-menu form[action="/logout"] button');
    await page.wait('[name=username]');
    await page.fill('[name=username]', 'synthetic-ordinary');
    await page.fill('[name=password]', 'CANARY-local-password');
    await page.click('button');
    await page.wait('form[data-create-token]');
  `)
  await expireConfirmation()
  browser(`
    await page.open(base + '/account');
    await page.fill('form[data-create-token] [name=label]', 'Synthetic token');
    await page.click('[data-token-tool="falcon-axi"]');
    await page.click('[data-token-command="falcon-axi"][value="detection list"]');
    await page.click('form[data-create-token] button');
    await page.wait('#reauth-dialog[open]');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-local-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('#created-token[open]');
    check(await page.eval(() => document.querySelector('[data-created-token]').value.startsWith('artd_')), 'Token was not shown');
    await page.click('[data-close-created-token]');
    await page.wait('form[data-create-token]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic token')), 'Token was not listed');
    check(await page.eval(() => document.querySelector('main').innerText.includes('detection list')), 'Exact selection was not retained alongside tool-wide access');
  `)
})

test('token creation applies tool instances to all selections', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    await page.open(base + '/account');
    await page.fill('form[data-create-token] [name=label]', 'Split token');
    await page.click('[data-token-tool="falcon-axi"]');
    await page.click('[data-token-instance="falcon-axi"][value="lab"]');
    await page.click('[data-token-command="falcon-axi"][value="detection list"]');
    await page.click('[data-token-command="falcon-axi"][value="detection show"]');
    await page.click('form[data-create-token] button');
    await page.wait('#created-token[open]');
    await page.click('[data-close-created-token]');
    await page.wait('form[data-create-token]');
    check(await page.eval(() => {
      const row = [...document.querySelectorAll('tr')].find(item => item.innerText.includes('Split token'));
      const items = [...row.querySelectorAll('li')];
      return items.length === 2 && items.every(item => item.innerText.includes('lab')) &&
        items.some(item => item.innerText.includes('detection list') && item.innerText.includes('detection show'));
    }), 'Tool instance scope was not retained for every selection');
  `)
})

test('People role links and stretched person and tool rows keep independent pointer targets', () => {
  browser(`
    check(await page.eval(() => {
      const chip = document.querySelector('tr.link:first-child a.chip');
      const box = chip.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).closest('a') === chip;
    }), 'Person overlay covers role link');
    await page.click('tr.link:first-child a.chip[href="/admin/roles/synthetic-role"]');
    await page.wait('form[action="/v1/admin/roles/synthetic-role"]');
    await page.open(base + '/admin/users');
    check(await page.eval(() => {
      const row = document.querySelector('tr.link');
      const box = row.querySelector('td.num').getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).closest('a') === row.querySelector('.row-link');
    }), 'Person row is not linked');
    await page.click('tr.link:first-child .row-link');
    await page.wait('form[action^="/v1/admin/users/"]');
    check(await page.eval(() => location.pathname.startsWith('/admin/users/')), 'Row did not open person');
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    await page.open(base + '/admin');
    const toolPath = await page.eval(() => document.querySelector('tr.link .row-link').getAttribute('href'));
    check(await page.eval(() => {
      const row = document.querySelector('tr.link');
      const box = row.lastElementChild.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).closest('a') === row.querySelector('.row-link');
    }), 'Tool row is not linked');
    await page.click('tr.link:first-child .row-link');
    await page.wait('form[data-save-tool]');
    check(await page.eval(() => location.pathname) === toolPath, 'Row did not open tool');
  `)
})

test('disabled People rows preserve person and role pointer targets', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=true]');
  `)
  for (const width of [1280, 420]) {
    chrome(['resize', String(width), '900'])
    browser(`
      await page.open(base + '/admin/users');
      check(await page.eval(() => {
        const row = document.querySelector('tr.dim');
        const link = row.querySelector('.row-link');
        return [...row.cells].every(cell => {
          const box = cell.getBoundingClientRect();
          return document.elementFromPoint(box.right - 2, box.y + box.height / 2)?.closest('a') === link;
        });
      }), 'Disabled person cells cover the person link');
      check(await page.eval(() => {
        const chip = document.querySelector('tr.dim a.chip');
        const box = chip.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('a') === chip;
      }), 'Disabled person overlay covers the role link');
      await page.click('tr.dim a.chip');
      await page.wait('form[action="/v1/admin/roles/synthetic-role"]');
    `)
  }
})

test('GitHub device connection shows the code, stores approval and cancels reconnect without replacement', () => {
  browser(`
    await page.open(base + '/admin/tools/gh-axi');
    await page.eval(async () => { await fetch('/test/trust-ca', { method: 'POST' }); });
    await page.fill('[data-connect-github] [name=instance]', 'default');
    await page.fill('[data-connect-github] [name=origin]', base);
    await page.click('[data-connect-github] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-github-authorization]:not([hidden])');
    check(await page.eval(() => document.querySelector('[data-github-code]').textContent === 'ABCD-EFGH'), 'Device code missing');
    check(await page.eval(() => document.querySelector('[data-github-link]').href === location.origin + '/login/device'), 'Wrong verification URL');
    await page.wait('tbody a[href="/admin/tools/gh-axi/instances/default"]');
    await openInstance('gh-axi');
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
    await page.click('.more-menu summary');
    await page.click('form:has([name=breakGlass]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=breakGlass][value=false])');
    check(await page.eval(() => document.querySelector('.account-menu summary').innerText.includes('Break-glass')), 'Designation was not shown');
    await page.click('.more-menu summary');
    await page.click('form:has([name=breakGlass]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/login"]');
    await page.open(base + '/admin');
    await page.wait('form[action="/login"]');`)
})

test('invitations show each new link once and allow resend and revoke through the real forms', async () => {
  browser(`
    await page.open(base + '/admin/settings/sign-in?add=entra');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('a[href^="/admin/settings/sign-in/"]');
    await page.open(base + '/admin');
    await page.click('a[href="/admin/invitations"]');
    await page.wait('form[data-invitation-link]');
    check(await page.eval(() => document.querySelector('main .callout').innerText.includes('can’t be claimed yet')), 'Missing disabled-provider banner');
    await page.click('a[data-sheet="sheet-new-invitation"]');
    await page.wait('#sheet-new-invitation[open]');
    await page.fill('[name=displayName]', 'Synthetic invited user');
    await page.fill('[name=expectedUsername]', 'synthetic@identity.example');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[data-invitation-link] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#invitation-link[open]');
    const first = await page.eval(() => document.querySelector('[data-claim-link]').value);
    check(first.startsWith(base + '/auth/sso/'), 'Invitation was not a link for this server');
    await page.click('#invitation-link form button');
    await page.wait('tr[data-invitation]');
    check(await page.eval(() => document.querySelector('[data-claim-link]').value === ''), 'Old link was redisplayed');
    check(await page.eval(() => document.querySelector('tr[data-invitation]').innerText.includes('Synthetic Role')), 'Direct role was not retained');
    await page.click('a[data-sheet^="sheet-resend-"]');
    await page.wait('dialog[id^="sheet-resend-"][open]');
    await page.click('form[action$="/resend"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#invitation-link[open]');
    const second = await page.eval(() => document.querySelector('[data-claim-link]').value);
    check(second !== first, 'Resend reused the old link');
    await page.click('#invitation-link form button');
    await page.wait('tr[data-invitation]');
    const expiry = await page.eval(() => document.querySelector('tr[data-invitation] time').dateTime);
    await page.click('form[action$="/revoke"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tr[data-invitation]:not(:has(form))');
    check(await page.eval(() => document.querySelector('tr[data-invitation]').innerText.includes('Revoked')), 'Invitation was not revoked');
    check(await page.eval(() => document.querySelector('tr[data-invitation] time').dateTime) === expiry, 'Revocation hid or changed expiry');
    check(await page.eval(async () => (await (await fetch('/v1/admin/sso/providers')).json()).providers.every(provider => !provider.enabled)), 'Invitations enabled SSO');
  `)
})

test('invitations link an existing local user through its detail page and recent-auth confirmation', async () => {
  browser(`
    await page.open(base + '/admin/settings/sign-in?add=entra');
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
    await page.click('#invitation-link form button');
    await page.wait('tr[data-invitation]');
    const invitations = await page.eval(async () => (await (await fetch('/v1/admin/sso/invitations')).json()).invitations);
    check(invitations.length === 1 && invitations[0].userId === 'synthetic-ordinary', 'Link invitation did not bind the existing account');
    const user = await page.eval(async () => (await (await fetch('/v1/admin/users/synthetic-ordinary')).json()));
    check(user.source === 'local' && user.enabled, 'Preparing the link changed local access');
  `)
})

test('sign-in settings stores, edits and removes a rule through recent-auth confirmation', async () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/settings/sign-in?add=entra');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.list-row strong a');
    const provider = await page.eval(() => document.querySelector('.list-row strong a').getAttribute('href'));
    await page.open(base + provider + '?tab=rules');
    check(await page.eval(() => document.querySelector('main').innerText.includes('No role rules')), 'Missing rule empty state');
    await page.click('a[href$="rule=new"]');
    await page.wait('dialog[open] [name=roleId]');
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
    await page.wait('[data-rule]');
    check(await page.eval(() => document.querySelector('[data-rule]').innerText.includes('CrowdStrike Falcon')), 'Missing target tool access');
    await page.click('[data-rule] .menu summary');
    await page.click('[data-rule] .menu a[href*="rule="]');
    await page.wait('dialog[open] form[data-method=PATCH]');
    await page.fill('dialog[open] form[data-method=PATCH] [name=value]', 'Artium.Analysts');
    await page.click('dialog[open] form[data-method=PATCH] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('body:not(:has(dialog[data-close-href])) [data-rule]');
    check(await page.eval(() => document.querySelector('[data-rule] .sentence').innerText.includes('Artium.Analysts')), 'Rule edit was not saved');
    check(await page.eval(() => document.querySelector('[data-rule] form[data-method=DELETE] [name=expectedRevision]').value === '2'), 'Rule revision did not advance');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Rule list overflows at 420px');
    await page.click('[data-rule] .menu summary');
    await page.click('[data-rule] form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('[data-confirm-button]').disabled), 'Removal did not require the typed value');
    await page.click('#confirmation button[value=cancel]');
    check(await page.eval(() => !!document.querySelector('[data-rule]')), 'Cancel removed the rule');
    await page.click('[data-rule] form[data-method=DELETE] button');
    await page.wait('#confirmation[open]');
    await page.fill('#confirmation-name', 'Artium.Analysts');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('section.card:not(:has([data-rule])) a[href$="rule=new"]');
    check(await page.eval(() => !document.querySelector('[data-rule]') && document.querySelector('main').innerText.includes('No role rules')), 'Rule was not removed');
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
    await page.wait('main .page-head .actions a[href$="add=choose"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('New providers start disabled')), 'Missing disabled-sign-in guidance');
    await page.click('main .page-head .actions a[href$="add=choose"]');
    await page.wait('dialog[open] [name=add][value=entra]:checked');
    await page.click('dialog[open] form button');
    await page.wait('[name=tenantId]');
    await page.fill('[name=name]', 'Synthetic provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.list-row strong a');
    await page.click('.list-row strong a');
    await page.wait('.vsteps');
    check(await page.eval(() => !document.querySelector('form[action$="/activation"]') && document.querySelector('main').innerText.includes('Set up this provider') && document.querySelector('main').innerText.includes('Not ready to enable')), 'Activation offered before completing setup');
    await page.click('.utabs a[href$="tab=credential"]');
    await page.wait('[data-certificate-pem]');
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
    await page.click('.utabs a[href$="tab=settings"]');
    await page.wait('form:has([name=name])');
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
    await page.open(base + '/admin/settings/sign-in?add=entra');
    await page.fill('[name=name]', 'Synthetic secret provider');
    await page.fill('[name=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.click('form[action="/v1/admin/sso/providers"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.list-row strong a');
    const provider = await page.eval(() => document.querySelector('.list-row strong a').getAttribute('href'));
    await page.open(base + provider + '?tab=credential');
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

test('Proxmox stored password administration saves one credential without a separate login step', () => {
  browser(`
    await addInstance('proxmox-axi');
    check(await page.eval(() => JSON.stringify([...document.querySelector('[data-profile-field=auth]').options].filter(option => option.value).map(option => JSON.parse(option.value))) === JSON.stringify(['api-token', 'password'])), 'Unexpected authentication choices');
    await page.fill('[data-profile-field=origin]', 'https://synthetic.invalid');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"password"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.fill('[data-profile-field=userId]', 'automation@pve');
    await page.fill('[data-profile-field=password]', 'CANARY-proxmox-browser-password');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    await openInstance('proxmox-axi');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=password]').value === '' && !document.documentElement.outerHTML.includes('CANARY-proxmox-browser-password')), 'Password redisplayed');
    check(await page.eval(() => document.querySelector('[data-profile-field=auth]').value === '"password"' && document.querySelector('[data-profile-field=userId]').value === 'automation@pve'), 'Selected identity was not saved');
    check(await page.eval(() => document.querySelector('main').innerText.includes('signs in automatically') && !document.querySelector('form[action*="/connect"]')), 'Automatic authentication guidance missing');
    await page.fill('[data-profile-field=userId]', 'different@pve');
    check(await page.eval(() => document.querySelector('[data-profile-field=password]').required), 'Changed username did not require a new password');
  `)
})

test('SSH administration explains dedicated identities without offering generic credential or trust overrides', () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/tools/ssh-axi');
    await page.wait('main');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Dedicated SSH identity')), 'Missing SSH identity guidance');
    check(await page.eval(() => !document.querySelector('form[action$="/credential"], [data-save-tool], [data-test-tool], [data-sheet="sheet-add-instance"]')), 'Generic SSH credential, instance or test form was offered');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'SSH connection page overflows at 420px');
    check(await page.eval(() => !document.querySelector('.utabs a[href$="tab=certificates"], form[action*="/certificates"]')), 'HTTPS trust controls were offered for SSH');
  `)
})

test('SSH dedicated administration provisions credentials, verified hosts and revision-checked bindings and grants', () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/ssh/credentials');
    await page.fill('[name=id]', 'new-credential');
    await page.fill('[name=privateKey]', 'CANARY-browser-ssh-key');
    await page.click('form[action$="/credential"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => [...document.querySelectorAll('[name=privateKey]')].every(input => input.value === '') && !document.documentElement.outerHTML.includes('CANARY-browser-ssh-key')), 'SSH key was redisplayed');
    check(await page.eval(() => [...document.querySelectorAll('main label[for]')].filter(label => label.closest('form')).every(label => label.control?.form === label.closest('form'))), 'Credential labels target controls in another form');
    await page.open(base + '/admin/ssh');
    check(await page.eval(() => !document.querySelector('[name=enabled]').checked && document.querySelector('[name=readOnly]').checked), 'New hosts must start disabled and read only');
    await page.fill('[name=id]', 'new-host');
    await page.fill('[name=address]', '127.0.0.1');
    await page.fill('[name=approvedHostKeys]', '["ssh-ed25519 YWJj"]');
    await page.fill('[name=allowedAddresses]', '["127.0.0.1"]');
    await page.fill('[name=independentVerification]', 'Synthetic offline browser verification');
    await page.click('[name=enabled]');
    await page.click('form[action$="/hosts"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/binding"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => [...document.querySelectorAll('main label[for]')].filter(label => label.closest('form')).every(label => label.control?.form === label.closest('form'))), 'Host labels target controls in another form');
    await page.fill('form[action$="/binding"] [name=username]', 'ordinary');
    await page.eval(() => { document.querySelector('form[action$="/binding"] [name=credential]').value = 'new-credential'; });
    await page.click('form[action$="/binding"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/grant"] [name=expectedRevision][value="2"]');
    await page.eval(() => { document.querySelector('form[action$="/grant"] [name=user]').value = 'synthetic-development-user'; });
    await page.click('form[action$="/grant"] [name=shell]');
    await page.click('form[action$="/grant"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/grant"] [name=expectedRevision][value="3"]');
    check(await page.eval(async () => {
      const data = await (await fetch('/v1/admin/ssh/hosts')).json();
      return data.hosts[0].readOnly && data.hosts[0].enabled && data.bindings[0].credential === 'new-credential' && data.grants[0].shell === 1;
    }), 'Saved host, binding and grant did not persist');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'SSH host administration overflows at 420px');
  `)
})

test('SSH write permissions default off and save without creating shared credentials', () => {
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/tools/ssh-axi?tab=writes');
    await page.wait('[data-write-access]');
    check(await page.eval(() => !document.querySelector('[data-write-access] [role=switch]').checked), 'SSH writes enabled by default');
    check(await page.eval(() => document.querySelector('[data-write-access]').innerText.includes('a writable host and current caller grants')), 'SSH host policy guidance missing');
    await page.click('[data-write-access] [role=switch]');
    await page.click('form[action$="/write-access"] button:not([form], [data-ops-select])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="2"]');
    check(await page.eval(async () => (await (await fetch('/v1/admin/tools/ssh-axi')).json()).writeAccess.enabled), 'SSH write setting did not persist');
    check(await page.eval(async () => !(await (await fetch('/v1/admin/tools/ssh-axi/credential')).json()).configured), 'Enabling writes created a credential');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'SSH write page overflows at 420px');
  `)
})

test('SSH audit escapes retained output and exports only recorded metadata', async () => {
  assert.equal((await fetch(fixture.clock.replace('/test/clock', '/test/ssh-audit'), { method: 'POST' })).status, 200)
  chrome(['resize', '420', '900'])
  browser(`
    await page.open(base + '/admin/ssh/audit');
    await page.wait('main');
    check(await page.eval(() => document.querySelector('main').innerText.includes('<script>window.syntheticOutputExecuted=true</script>')), 'Retained output was not displayed as text');
    check(await page.eval(() => window.syntheticOutputExecuted !== true), 'Untrusted output executed');
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'SSH audit overflows at 420px');
    const exported = await page.eval(async () => await (await fetch('/v1/admin/ssh/audit/export')).json());
    check(exported.executions[0].id === 'exec_browser_fixture' && exported.executions[0].samples === 'omitted', 'Metadata export missing');
    check(!JSON.stringify(exported).includes('syntheticOutputExecuted'), 'Metadata export included output');
    const actions = await page.eval(async () => (await (await fetch('/v1/admin/audit?event=admin-change')).json()).records.map(row => row.action));
    check(actions.includes('ssh-audit-read') && actions.includes('ssh-audit-export'), 'Audit read or export was not recorded');
  `)
})

test('Kubernetes certificate editor saves separate fields and requires a key when the certificate changes', () => {
  browser(`
    await addInstance('kubernetes-axi');
    await page.fill('[data-profile-field=origin]', 'https://cluster.example');
    await page.fill('[data-profile-field=certificateAuthority]', 'CANARY-cluster-CA');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"certificate"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    check(await page.eval(() => document.querySelector('[data-certificate]').hidden), 'Unsupported combined certificate upload is visible');
    check(await page.eval(() => document.querySelector('[data-profile-field=clientCertificate]').tagName === 'TEXTAREA'), 'Client certificate must preserve PEM lines');
    await page.fill('[data-profile-field=clientCertificate]', 'CANARY-client-certificate');
    await page.fill('[data-profile-field=privateKey]', 'CANARY-client-private-key');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    await openInstance('kubernetes-axi');
    await page.wait('form[action$="/credential"] [name=expectedRevision][value="1"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=privateKey]').value === '' && !document.documentElement.outerHTML.includes('CANARY-client-private-key')), 'Private key redisplayed');
    check(await page.eval(() => !document.querySelector('[data-profile-field=privateKey]').required), 'Unchanged identity cannot retain its stored key');
    await page.fill('[data-profile-field=clientCertificate]', 'CANARY-replacement-certificate');
    check(await page.eval(() => document.querySelector('[data-profile-field=privateKey]').required), 'Changed certificate does not require a replacement key');
  `)
})

test('audit request ID copies and offers manual selection when clipboard is unavailable', async () => {
  assert.equal((await fetch(fixture.clock.replace('/test/clock', '/test/audit'), { method: 'POST' })).status, 200)
  browser(`
    await page.open(base + '/admin/audit?event=run-start&limit=1');
    await page.click('tbody th a');
    await page.wait('#record');
    await page.eval(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copied = text; }
      } });
    });
    await page.click('[aria-label="Copy request ID"]');
    check(await page.eval(() => window.copied === 'synthetic-run-102' &&
      document.querySelector('[data-copy-status]').textContent === 'Copied.'), 'Request ID copy failed');
    await page.eval(() => {
      navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
    });
    await page.click('[aria-label="Copy request ID"]');
    check(await page.eval(() => document.activeElement.value === 'synthetic-run-102' &&
      document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 'synthetic-run-102'.length &&
      document.querySelector('[data-copy-status]').textContent === 'Copy unavailable. Copy the selected text manually.'), 'Request ID not selected for manual copying');
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
      // Interstitials use the auth card, which names the signed-in person beside its sign-out link.
      check(await page.eval(() => document.querySelector('.account-menu summary')?.textContent.includes('Password') || document.querySelector('form.auth-foot[action="/logout"]')?.textContent.includes('Synthetic User')), 'Missing signed-in identity on ' + path);
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
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: base, auth: 'token', token: 'CANARY-certificate-review' });
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
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
    check(await page.eval(() => document.querySelector('#certificate-inspection').open), 'Trust saved without fingerprint confirmation');
    await page.click('[name=confirmedFingerprint]');
    await page.click('[data-trust-certificate] button');
    await page.wait('form[data-method=DELETE][action$="/certificates"]');
    await page.eval(async () => {
      // The reloaded form can appear before the stylesheet finishes loading.
      if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    });
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Trusted fingerprint overflows the narrow screen');
    check(await page.eval(() => !document.querySelector('#confirmation[open]')), 'Trust requires an extra confirmation');
    check(await page.eval(async () => {
      const result = await (await fetch('/v1/admin/tools/vectra-axi/instances/default/certificates')).json();
      const audit = await (await fetch('/v1/admin/audit?event=admin-change')).json();
      return result.certificates.length === 1 && result.certificates[0].mode === 'ca' && audit.records.some(row => row.action === 'trust-certificate' && row.target_id === result.certificates[0].certificate.fingerprint);
    }), 'Trust or fingerprint audit missing');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Connected'), 'Automatic credential test did not connect after trust');
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

test('trust automatically tests credentials and displays the exact failure', () => {
  browser(`
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: base, auth: 'token', token: 'CANARY-invalid' });
    await page.click('form[data-test-tool] button');
    await page.wait('[data-inspect-certificate]:not([hidden])');
    await page.click('[data-inspect-certificate] button');
    await page.wait('#certificate-inspection[open]');
    await page.click('[name=confirmedFingerprint]');
    await page.click('[data-trust-certificate] button');
    await page.wait('form[data-method=DELETE][action$="/certificates"]');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.includes('The tool exited unsuccessfully.')), 'Exact test failure missing');
    check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.includes('tool run') && !document.querySelector('[data-check-diagnostic]').textContent.includes('Tool exited with status 1.')), 'Structured tool failure missing');
  `)
})

for (const [failure, expected] of [
  ['network', 'Connection test: Could not reach the artium admin server.'],
  ['parse', 'Connection test: response was not valid JSON. HTTP 200.'],
  ['structured', 'Connection test: HTTP 503. The tool exited unsuccessfully. (TOOL_FAILED). Failed step: token acquisition. Code: EHOSTUNREACH. Provider: AADSTS7000222. Upstream HTTP 503.'],
]) test('automatic retest reports a safe ' + failure + ' detail', () => {
  browser(`
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: base, auth: 'token', token: 'CANARY-valid' });
    await page.click('form[data-test-tool] button');
    await page.wait('[data-inspect-certificate]:not([hidden])');
    await page.click('[data-inspect-certificate] button');
    await page.wait('#certificate-inspection[open]');
    await page.click('[name=confirmedFingerprint]');
    await page.eval(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        if (String(args[0]).endsWith('/test')) {
          ${failure === 'network' ? "throw new TypeError('Échec réseau CANARY-private-value', { cause: { code: 'ECONNREFUSED' } });" : failure === 'structured'
            ? "return Response.json({ error: { code: 'TOOL_FAILED', message: 'CANARY-private-value', diagnostic: { stage: 'token acquisition', toolCode: 'EHOSTUNREACH', providerCode: 'AADSTS7000222', upstreamStatus: 503, message: 'CANARY-private-value' } } }, { status: 503 });"
            : "return new Response('CANARY-private-value', { status: 200 });"}
        }
        return original(...args);
      };
    });
    await page.click('[data-trust-certificate] button');
    await page.wait('form[data-method=DELETE][action$="/certificates"]');
    const message = await page.eval(() => document.querySelector('[data-test-result]').textContent);
    check(message.startsWith('${expected}'), 'Missing safe failure category: ' + message);
    check(!message.includes('CANARY-private-value'), 'Client failure exposed response or exception text');
  `)
})

test('disabled tool retains cached test outcomes after reloading the instance', () => {
  browser(`
    await page.open(base + '/admin/tools/vectra-axi');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) [role=switch]').getAttribute('aria-checked') === 'false'), 'Tool must start disabled');
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: base, auth: 'token', token: 'CANARY-cached-test' });
    await page.click('form[data-test-tool] button');
    await page.wait('[data-check-failure]:not([hidden]) [data-check-error]:not(:empty)');
    const error = await page.eval(() => document.querySelector('[data-check-error]').textContent);
    check(error === 'UPSTREAM_TLS_FAILED', 'Loopback fixture must fail on its untrusted certificate');
    const diagnostic = await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.trim());
    check(diagnostic.length > 0, 'Failure must explain the error');
    await openInstance('vectra-axi');
    check(await page.eval(() => !document.querySelector('[data-check-failure]').hidden), 'Cached failure callout hidden after navigation');
    check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent.trim()) === diagnostic, 'Cached diagnostic changed');
    check(await page.eval(() => document.querySelector('[data-check-summary]').textContent.trim().length > 0), 'Cached failure explanation missing');
    check(await page.eval(() => document.querySelector('[data-check-error]').textContent) === error, 'Cached failure category changed');
    check(await page.eval(() => document.querySelector('[data-tool-state]').textContent.includes('Failing')), 'Detail badge lost the failure');
    check(await page.eval(() => document.querySelector('[data-test-checklist]').textContent.includes('Failing:')), 'Setup lost the failed outcome');
    check(await page.eval(async () => (await (await fetch('/v1/admin/tools/vectra-axi')).json()).enabled === false), 'Testing enabled the tool');
    await page.open(base + '/admin/tools/vectra-axi');
    await page.wait('tbody a[href="/admin/tools/vectra-axi/instances/default"]');
    check(await page.eval(() => document.querySelector('tbody').textContent.includes('Failing')), 'Instances tab lost the failed outcome');
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
    await openInstance('vectra-axi');
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Test passed.'), 'Loopback test did not pass after trust');
    await openInstance('vectra-axi');
    check(await page.eval(() => document.querySelector('[data-tool-state]').textContent.includes('Healthy')), 'Detail lost the successful outcome');
    check(await page.eval(() => document.querySelector('[data-check-failure]').hidden), 'Successful test retained the failure callout');
    check(await page.eval(() => document.querySelector('[data-test-checklist]').textContent.includes('Passed')), 'Setup lost the successful outcome');
    check(await page.eval(async () => (await (await fetch('/v1/admin/tools/vectra-axi')).json()).enabled === false), 'Successful test enabled the tool');
    await page.open(base + '/admin/tools');
    await page.wait('tbody a[href="/admin/tools/vectra-axi"]');
    check(await page.eval(() => document.querySelector('tbody a[href="/admin/tools/vectra-axi"]').closest('tr').querySelector('[data-label=State]').textContent.includes('Healthy')), 'List lost the successful outcome');
  `)
})

for (const action of ['save', 'test']) {
  test('credential diagnostics retain the current ' + action + ' response over cached health', () => {
    browser(`
      await createInstance('falcon-axi', falconValue);
      await page.eval(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (url, options) => {
          if (new URL(url, location.href).pathname !== '/v1/admin/tools/falcon-axi/instances/default/test') return original(url, options);
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
      check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent === 'configuration'), 'Current test diagnostic was replaced');
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
        await createInstance('falcon-axi', falconValue);
        await page.wait('[data-credential-editor]');
        await page.eval(() => {
          const original = window.fetch.bind(window);
          window.fetch = async (url, options) => {
            if (new URL(url, location.href).pathname !== '/v1/admin/tools/falcon-axi/instances/default/test') return original(url, options);
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
          check(await page.eval(() => sessionStorage.getItem('credential-test:/admin/tools/falcon-axi/instances/default') === null), 'Redirect retained a success result');
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
    check(await page.eval(() => ['Instances', 'Write permissions', 'Access', 'Advanced'].every(tab => [...document.querySelectorAll('nav.utabs a')].some(link => link.textContent.includes(tab)))), 'Tool tabs missing');
    await page.open(base + '/admin/tools/${entry.tool}?tab=advanced');
    await page.fill('[name=nativeSettings]', ${JSON.stringify(JSON.stringify(entry.settings))});
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=nativeSettings]) [name=expectedRevision][value="2"]');
    await addInstance('${entry.tool}');
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
    await openInstance('${entry.tool}');
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
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.example', auth: 'token', token: 'CANARY-initial-token' });
    await page.eval(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (new URL(url, location.href).pathname !== '/v1/admin/tools/vectra-axi/instances/default/test') return original(url, options);
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
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('[data-profile-field=origin]').value === 'https://appliance.example'), 'Stored canonical origin missing');
    check(await page.eval(() => document.querySelector('[data-profile-field=token]').value === ''), 'Stored secret was displayed');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.includes('origin: canonicalized format.')), 'Origin normalization notice missing');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.includes('token: removed surrounding whitespace.')), 'Secret normalization notice missing');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent.startsWith(${JSON.stringify(saveAndTest ? 'Saved. Test failed.' : 'Saved.')})), 'Save result missing');
    if (${saveAndTest}) check(await page.eval(() => document.querySelector('[data-check-diagnostic]').textContent === 'DNS'), 'Current diagnostic missing');
    check(await page.eval(() => !document.querySelector('main').innerText.includes('CANARY-normalized-token')), 'Secret appeared in notice');
  `)
})
}

test('LDAP saved CA PEM survives browser edits and multi-line secrets reach delivered files unchanged', async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nCANARY-first-line\nCANARY-second-line\n-----END CERTIFICATE-----\n'
  const password = 'CANARY-first-line\nCANARY-second-line\n'
  browser(`
    await createInstance('ldap-axi', { url: 'ldaps://directory.example', auth: 'simple', bindDn: 'cn=reader,dc=example', bindPassword: 'CANARY-original', caFile: ${JSON.stringify(pem)} });
    await page.fill('textarea[data-profile-field=bindPassword]', ${JSON.stringify(password)});
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-test-result]').textContent === 'Saved. Test passed.'), 'LDAP test failed: ' + await page.eval(() => document.querySelector('[data-test-result]').textContent));
    await openInstance('ldap-axi');
    check(await page.eval(() => document.querySelector('fieldset pre').textContent === ${JSON.stringify(pem)} &&
      !document.querySelector('fieldset pre').isContentEditable && document.querySelector('textarea[data-profile-field=caFile]').value === ''), 'Saved PEM or separate replacement input was incorrect');
  `)
  const { stored, delivered } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/ldap-axi'))).json()
  assert.equal(stored.caFile, pem)
  assert.equal(stored.bindPassword, password)
  assert.equal(delivered.caFile, pem)
  assert.equal(delivered.bindPassword, password)
})

for (const tool of ['technitium-axi', 'unifi-axi']) for (const edited of [false, true]) test(tool + ' endpoint changes ' + (edited ? 'keep explicitly edited' : 'omit untouched') + ' certificate overrides', async () => {
  const certificate = fixture.certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0]
  const tls = { trustedCertificatePem: certificate, peerFingerprintSha256: new X509Certificate(certificate).fingerprint256.replaceAll(':', ''), connectAddress: '127.0.0.1' }
  const value = tool === 'unifi-axi'
    ? { origin: 'https://controller.example', apiKey: 'CANARY-key', tls }
    : { origin: 'https://dns.example', auth: 'token', tokenKind: 'api', token: 'CANARY-token', tlsServerName: 'dns.example' }
  const field = tool === 'unifi-axi' ? 'tls.connectAddress' : 'tlsServerName'
  browser(`
    await createInstance('${tool}', ${JSON.stringify(value)});
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('[data-profile-field="${field}"]').value === ${JSON.stringify(tool === 'unifi-axi' ? tls.connectAddress : value.tlsServerName)}), 'Unchanged override was lost');
    await page.fill('[data-profile-field=origin]', 'https://replacement.example');
    await page.fill('[data-profile-field=${tool === 'unifi-axi' ? 'apiKey' : 'token'}]', 'CANARY-new-secret');
    if (${edited}) {
      await page.fill('[data-profile-field="${field}"]', ${JSON.stringify(tool === 'unifi-axi' ? '127.0.0.2' : 'replacement.example')});
      ${tool === 'unifi-axi' ? `await page.click('details:has([data-profile-field="tls.trustedCertificatePem"]) summary'); await page.fill('[data-profile-field="tls.trustedCertificatePem"]', ${JSON.stringify(certificate)}); await page.fill('[data-profile-field="tls.peerFingerprintSha256"]', ${JSON.stringify(tls.peerFingerprintSha256)});` : ''}
    }
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="3"]');
    check(await page.eval(() => document.querySelector('[data-profile-field="${field}"]').value === ${JSON.stringify(edited ? (tool === 'unifi-axi' ? '127.0.0.2' : 'replacement.example') : '')}), 'Endpoint override was incorrect');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/' + tool))).json()
  assert.equal(stored.origin, 'https://replacement.example')
  assert.equal(tool === 'unifi-axi' ? stored.tls?.connectAddress : stored.tlsServerName, edited ? (tool === 'unifi-axi' ? '127.0.0.2' : 'replacement.example') : undefined)
})

for (const field of ['certificate', 'fingerprint']) test('UniFi ' + field + ' replacement requires both trust values', async () => {
  const certificate = fixture.certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0]
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(':', '')
  const tls = { trustedCertificatePem: certificate, peerFingerprintSha256: fingerprint }
  browser(`
    await createInstance('unifi-axi', ${JSON.stringify({ origin: 'https://controller.example', apiKey: 'CANARY-key', tls })});
    await page.click('[data-save-and-test]');
    await page.click('details:has([data-profile-field="tls.trustedCertificatePem"]) summary');
    await page.fill('[data-profile-field="${field === 'certificate' ? 'tls.trustedCertificatePem' : 'tls.peerFingerprintSha256'}"]', ${JSON.stringify(field === 'certificate' ? certificate : fingerprint)});
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('#message:not(:empty)');
    check(await page.eval(() => document.querySelector('#message').textContent.includes('Enter the trusted certificate and SHA-256 fingerprint together.')), 'Missing paired trust error');
    await page.fill('[data-profile-field="${field === 'certificate' ? 'tls.peerFingerprintSha256' : 'tls.trustedCertificatePem'}"]', ${JSON.stringify(field === 'certificate' ? fingerprint : certificate)});
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[data-save-tool] [name=expectedRevision][value="2"]');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/unifi-axi'))).json()
  assert.deepEqual(stored.tls, tls)
})

for (const tool of ['az-axi', 'mg-axi']) test(tool + ' certificate PEM calculates the fingerprint and saves the matching key', async () => {
  browser(`
    await addInstance('${tool}');
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
    await page.wait('[data-test-result]:not(:empty)');
    await openInstance('${tool}');
    check(await page.eval(() => document.querySelector('[data-profile-field=privateKey]').value === ''), 'Private key exposed');
  `)
  const { stored } = await (await fetch(fixture.clock.replace('/test/clock', '/test/tools/' + tool))).json()
  const certificate = new X509Certificate(fixture.certificatePem)
  assert.equal(stored.thumbprintSha256, certificate.fingerprint256.replaceAll(':', '').toLowerCase())
  assert.equal(stored.privateKey, fixture.certificatePem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/)[0] + '\n')
})

test('malformed certificate PEM keeps the draft and leaves the credential unconfigured', async () => {
  browser(`
    await addInstance('az-axi');
    await page.eval(() => { const input = document.querySelector('[data-profile-field=auth]'); input.value = '"certificate"'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.fill('[data-profile-field=tenantId]', '11111111-1111-4111-8111-111111111111');
    await page.fill('[data-profile-field=clientId]', '22222222-2222-4222-8222-222222222222');
    await page.fill('[data-certificate-pem]', 'CANARY-invalid-pem');
    await page.click('[data-save-and-test]');
    await page.click('form[data-save-tool] button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('[data-sheet-message]:not(:empty)');
    check(await page.eval(() => document.querySelector('[data-sheet-message]').textContent.includes('INVALID_INPUT')), 'Missing PEM error');
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
    await page.click('nav.utabs a[href$="?tab=access"]');
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

test('Kubernetes mutation workflows default off and require the administrator switch', () => {
  browser(`
    await page.open(base + '/admin/tools/kubernetes-axi?tab=writes');
    await page.wait('form[action$="/write-access"]');
    check(await page.eval(() => document.querySelector('[data-write-access] input[role=switch]').checked === false), 'Kubernetes writes enabled by default');
    check(await page.eval(() => document.querySelector('[data-write-access]').innerText.includes('confirm exact digests')), 'Native confirmation guidance missing');
    await page.click('[data-write-access] input[role=switch]');
    await page.click('form[action$="/write-access"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="2"]');
    await page.open(base + '/admin/tools/kubernetes-axi?tab=writes');
    await page.wait('form[action$="/write-access"]');
    check(await page.eval(() => document.querySelector('[data-write-access] input[role=switch]').checked === true), 'Administrator permission did not persist');
    await page.open(base + '/admin/tools/kubernetes-axi?tab=advanced');
    await page.wait('[name=nativeSettings]');
    check(await page.eval(() => {
      const settings = JSON.parse(document.querySelector('[name=nativeSettings]').value);
      return settings.allowWrites === true && settings.collectionDelete !== true && settings.acquireCredential !== true;
    }), 'Master switch enabled bulk deletion');
    check(await page.eval(() => document.querySelector('main').innerText.includes('server-dry-run')), 'Native workflow settings guidance missing');
    await page.fill('[name=nativeSettings]', JSON.stringify({ allowWrites: true, acquireCredential: true, sessions: {
      lifetimeSeconds: 300, outputBytes: 65536,
    } }));
    await page.click('form:has([name=nativeSettings]) button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form:has([name=nativeSettings]) [name=expectedRevision][value="3"]');
    await page.open(base + '/admin/tools/kubernetes-axi?tab=advanced');
    await page.wait('[name=nativeSettings]');
    check(await page.eval(() => {
      const settings = JSON.parse(document.querySelector('[name=nativeSettings]').value);
      return settings.allowWrites === true && settings.collectionDelete !== true && settings.acquireCredential === true
        && !('grants' in settings.sessions)
        && settings.sessions.lifetimeSeconds === 300 && settings.sessions.outputBytes === 65536;
    }), 'Session limits did not persist');
    await page.open(base + '/admin/tools/kubernetes-axi?tab=access&sheet=grants-sessions-add');
    await page.wait('#sheet-grants-sessions-add[open]');
    await page.eval(() => { document.querySelector('#sheet-grants-sessions-add [name=userId]').value = 'synthetic-development-user'; });
    await page.click('#sheet-grants-sessions-add [name=operations][value=exec]');
    await page.click('#sheet-grants-sessions-add [name=operations][value=logs]');
    await page.click('#sheet-grants-sessions-add [name=operations][value=port-forward]');
    await page.click('#sheet-grants-sessions-add form button');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('a[href*="grants-sessions-synthetic-development-user"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('logs, exec, port-forward')), 'Session grants did not persist');
  `)
})

test('Falcon offers exact lifecycle and RTR capabilities off by default', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi?tab=writes');
    await page.wait('[data-write-access]');
    for (const operation of ['search start', 'search stop', 'host usb', 'identity activity', 'malquery search', 'rtr run']) {
      check(await page.eval('document.querySelector(' + JSON.stringify('[name=operations][value="' + operation + '"]') + ')?.checked === false'), operation + ' missing or selected by default');
    }
    check(await page.eval(() => document.querySelector('[data-write-access] input[role=switch]').checked === false), 'Falcon writes enabled by default');
    check(await page.eval(() => document.querySelector('[data-write-access]').innerText.includes('exact --execute/--confirm')), 'Native RTR confirmation guidance missing');
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

for (const tool of ['unifi-axi', 'proxmox-axi']) test(tool + ' operation picker labels stay within their desktop grid cells', () => {
  chrome(['resize', '1280', '900'])
  browser(`
    await page.open(base + '/admin/tools/${tool}?tab=writes');
    const overflowing = await page.eval(() => {
      document.querySelectorAll('[data-ops-group]').forEach(group => { group.open = true; });
      return [...document.querySelectorAll('label.op')].filter(label => {
        const bounds = label.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label.querySelector('span'));
        return [...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
      }).map(label => label.textContent.trim());
    });
    check(overflowing.length === 0, 'Operation labels overflow their cells: ' + overflowing.join(', '));
  `)
})

for (const tool of ['mg-axi', 'vectra-axi', 'gitea-axi', 'unifi-axi', 'proxmox-axi']) test(tool + ' operation picker matches the pinned catalogue and saves the selection', () => {
  browser(`
    await page.open(base + '/admin/tools/${tool}?tab=writes');
    const initial = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    const choices = await page.eval(() => [...document.querySelectorAll('[name=operations]')].map(input => input.value));
    check(JSON.stringify([...choices].sort()) === JSON.stringify([...initial.writeAccess.supportedOperations].sort()), 'Picker differs from pinned catalogue');
    check(await page.eval(() => [...document.querySelectorAll('[name=operations]')].every(input => !input.checked)), 'Unexpected initial selection');
    await page.click('[data-write-access] [role=switch]');
    await page.click('form[action$="/write-access"] button:not([form], [data-ops-select])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('#message:not(:empty)');
    check(await page.eval(() => document.querySelector('#message').innerText.includes('Select at least one')), 'Empty enabled allow-list accepted');
    await page.click('[name=operations]');
    await page.click('form[action$="/write-access"] button:not([form], [data-ops-select])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="2"]');
    const saved = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    check(saved.writeAccess.enabled && JSON.stringify(saved.writeAccess.allowedOperations) === JSON.stringify([choices[0]]), 'Selection not saved');
    check(await page.eval(() => document.querySelector('[name=operations]').checked), 'Selection not reflected');
    check(await page.eval(() => document.querySelector('[data-ops-group]').open), 'Group with a selection is collapsed');
    await page.click('[data-write-access] [role=switch]');
    await page.click('[name=operations]');
    await page.click('form[action$="/write-access"] button:not([form], [data-ops-select])');
    await page.wait('#confirmation[open]'); await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action$="/write-access"] [name=expectedRevision][value="3"]');
    const cleared = await page.eval(async () => (await (await fetch('/v1/admin/tools/${tool}')).json()));
    check(!cleared.writeAccess.enabled && cleared.writeAccess.allowedOperations.length === 0, 'Empty selection not saved');
  `)
})

for (const tool of ['mg-axi', 'vectra-axi']) test(tool + ' group controls select and clear only shown operations', () => {
  browser(`
    await page.open(base + '/admin/tools/${tool}?tab=writes');
    const state = () => page.eval(() => {
      const group = document.querySelector('[data-ops-group]:has([data-delete])');
      const operations = [...group.querySelectorAll('[data-op]')];
      return { total: operations.length, visible: operations.filter(operation => !operation.hidden).length, checked: operations.filter(operation => operation.querySelector('input').checked).length,
        deletes: operations.filter(operation => operation.hasAttribute('data-delete')).length,
        deletesChecked: operations.filter(operation => operation.hasAttribute('data-delete') && operation.querySelector('input').checked).length,
        hiddenChecked: operations.filter(operation => operation.hidden && operation.querySelector('input').checked).length,
        otherChecked: [...document.querySelectorAll('[data-ops-group]')].filter(other => other !== group).flatMap(other => [...other.querySelectorAll('[data-op] input:checked')]).length };
    });
    const none = await state();
    await page.eval(() => { document.querySelector('[data-ops-group]:has([data-delete])').open = true; });
    await page.click('[data-ops-group]:has([data-delete]) [data-ops-select=all]');
    const all = await state();
    check(all.deletes > 0 && all.checked === all.total && all.deletesChecked === all.deletes, 'Select all must include every operation in the group, including deletes');
    check(all.otherChecked === 0, 'Select all changed another group');
    await page.eval(() => {
      const input = document.querySelector('[name=q]');
      input.value = document.querySelector('[data-ops-group]:has([data-delete]) [data-op]').dataset.op;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('[data-ops-group]:has([data-delete]) [data-ops-select=none]');
    const filteredClear = await state();
    check(filteredClear.checked === all.checked - 1 && filteredClear.hiddenChecked === filteredClear.checked, 'Clear all must clear only the shown operations');
    await page.click('[data-ops-group]:has([data-delete]) [data-ops-select=all]');
    check((await state()).checked === all.checked, 'Select all must select the shown operation');
    check(none.checked === 0, 'Unexpected initial selection');
    await page.eval(() => {
      const input = document.querySelector('[name=q]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('label:has([name=show][value=selected])');
    await page.click('[data-ops-group]:has([data-delete]) [data-op]:not([hidden]) input');
    const individualClear = await state();
    check(individualClear.checked === all.checked - 1 && individualClear.visible === individualClear.checked, 'Unchecked operation remains visible in Selected view');
    await page.click('[data-ops-group]:has([data-delete]) [data-ops-select=none]');
    check(await page.eval(() => document.querySelector('[data-ops-empty]').hidden === false && !document.querySelector('[data-ops-group]:not([hidden])')), 'Cleared operations remain visible in Selected view');
  `)
})

for (const tool of ['mg-axi', 'vectra-axi']) test(tool + ' card-level controls act on every shown operation and keep the selected counts live', () => {
  browser(`
    await page.open(base + '/admin/tools/${tool}?tab=writes');
    const state = () => page.eval(() => {
      const operations = [...document.querySelectorAll('[data-op]')];
      const checked = operations.filter(operation => operation.querySelector('input').checked);
      return { total: operations.length, checked: checked.length, visible: operations.filter(operation => !operation.hidden).length,
        hiddenChecked: checked.filter(operation => operation.hidden).length,
        collapsedChecked: checked.filter(operation => !operation.closest('[data-ops-group]').open).length,
        header: document.querySelector('[data-ops-selected]').textContent, headline: document.querySelector('[data-ops-selected]').parentElement.textContent,
        groupCounts: [...document.querySelectorAll('[data-ops-group]')].every(group => group.querySelector('[data-ops-picked]').textContent === (group.querySelectorAll('[data-op] input:checked').length ? ' · ' + group.querySelectorAll('[data-op] input:checked').length + ' selected' : '')) };
    });
    const none = await state();
    check(none.checked === 0 && none.header === '0', 'Unexpected initial selection');
    await page.click('.card-body > [data-ops-actions] [data-ops-select=all]');
    const all = await state();
    check(all.checked === all.total && all.collapsedChecked > 0, 'Card-level Select all must reach every group, collapsed ones included');
    check(all.header === String(all.total) && all.headline.startsWith(all.total + ' of ' + all.total + ' selected'), 'Header count stale after Select all: ' + all.headline);
    check(all.groupCounts, 'Group counts stale after Select all');
    await page.eval(() => {
      const input = document.querySelector('[name=q]');
      input.value = document.querySelector('[data-op]').dataset.op;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const shown = await state();
    check(shown.visible > 0 && shown.visible < shown.total, 'Filter must hide some operations');
    await page.click('.card-body > [data-ops-actions] [data-ops-select=none]');
    const filtered = await state();
    check(filtered.checked === all.total - shown.visible &&filtered.hiddenChecked === filtered.checked, 'Card-level Clear all must clear only shown operations');
    check(filtered.header === String(filtered.checked) && filtered.groupCounts, 'Counts stale after filtered Clear all');
    await page.eval(() => {
      const input = document.querySelector('[name=q]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('label:has([name=show][value=selected])');
    const selectedView = await state();
    check(selectedView.visible === selectedView.checked && selectedView.header === String(selectedView.checked), 'Selected view disagrees with the header count');
    await page.click('[data-op]:not([hidden]) input');
    const unchecked = await state();
    check(unchecked.header === String(selectedView.checked - 1) && unchecked.groupCounts, 'Header count stale after an individual change');
  `)
})

test('changing Vectra authentication requires new secrets and saves only the selected method', async () => {
  browser(`
    await createInstance('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.example', auth: 'token', token: 'CANARY-original-token' });
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
    await page.wait(selector);
    await page.click(selector + ' button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('synthetic-ordinary')), 'Missing confirmation target');
    check(await page.eval(() => document.querySelector('[data-consequence]').textContent.includes('all their browser and CLI sessions')), 'Missing consequence');
    await page.click('#confirmation button[value=cancel]');
    await page.wait('#confirmation:not([open])');
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Disable…'), 'Cancel changed enabled state');
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
    check(await page.eval(() => document.querySelector('[data-filters-apply]').hidden), 'Filter chips did not switch to applying on change');
    await page.fill('[name=q]', 'synthetic');
    await page.eval(() => {
      const form = document.querySelector('form[data-filters]');
      form.elements.source.value = 'local';
      form.elements.status.value = 'enabled';
      form.elements.role.value = 'synthetic-role';
      form.requestSubmit();
    });
    await page.wait('[name=q][value="synthetic"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Showing 1 of 2')), 'Missing filtered count');
    await page.click('a[href*="cursor="]');
    await page.wait('a[href="/admin/users/synthetic-ordinary"]');
    check(await page.eval(() => ['q', 'source', 'status', 'role'].every(name => new URLSearchParams(location.search).has(name))), 'Pagination lost filters');
    await page.fill('[name=q]', 'no-matching-person');
    await page.eval(() => document.querySelector('form[data-filters]').requestSubmit());
    await page.wait('[name=q][value="no-matching-person"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Nobody matches these filters')), 'Missing empty-state guidance');
    check(await page.eval(() => !new URLSearchParams(location.search).has('cursor')), 'Search retained old cursor');
  `)
})

test('a local user can be created from the table and its profile edited from detail', () => {
  browser(`
    const create = 'form[action="/v1/admin/users"]';
    await page.click('a[data-sheet="sheet-add-user"]');
    await page.wait('#sheet-add-user[open]');
    await page.press('Escape');
    await page.wait('a[data-sheet="sheet-add-user"]:focus');
    await page.press('Enter');
    await page.wait('#sheet-add-user[open]');
    await page.fill(create + ' [name=username]', 'synthetic-new');
    await page.fill(create + ' [name=displayName]', 'New analyst');
    await page.fill(create + ' [name=temporaryPassword]', 'CANARY-temporary-password');
    check(await page.eval(() => document.querySelector('#sheet-add-user [name=temporaryPassword]').type === 'password'
      && !document.querySelector('#sheet-add-user [data-generate-password]')), 'Add user must keep manual passwords masked');
    await page.click(create + ' button:not([type=button])');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('tbody a.row-link:not([href="/admin/users/synthetic-development-user"]):not([href="/admin/users/synthetic-ordinary"])');
    const href = await page.eval(() => [...document.querySelectorAll('tbody tr')].find(row => row.innerText.includes('synthetic-new')).querySelector('a.row-link').getAttribute('href'));
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
    await page.click('.crumbs a[href="/admin/users"]');
    await page.wait('tbody');
    check(await page.eval(() => [...document.querySelectorAll('tbody tr')].some(row => row.innerText.includes('Updated analyst') && row.innerText.includes('Admin'))), 'Table did not reflect profile');
  `)
})

test('role tables align desktop columns and retain narrow member labels', () => {
  chrome(['resize', '1280', '900'])
  browser(`
    for (const path of ['/admin/roles', '/admin/roles/synthetic-role']) {
      await page.open(base + path);
      check(await page.eval(() => {
        const table = document.querySelector('table.row-links');
        const headings = [...table.querySelectorAll('thead th')];
        const cells = [...table.querySelector('tbody tr').children];
        return getComputedStyle(table).display === 'table' && headings.every((heading, index) =>
          Math.abs(heading.getBoundingClientRect().x - cells[index].getBoundingClientRect().x) < 1);
      }), 'Role table columns do not align');
    }
  `)
  chrome(['resize', '420', '900'])
  browser(`
    for (const path of ['/admin/roles', '/admin/roles/synthetic-role']) {
      await page.open(base + path);
      check(await page.eval(() => {
        const table = document.querySelector('table.row-links');
        const row = table.querySelector('tbody tr');
        return getComputedStyle(row).display === 'flex' &&
          [...row.querySelectorAll('[data-label]')].every(cell =>
            getComputedStyle(cell, '::before').content.includes(cell.dataset.label)) &&
          document.documentElement.scrollWidth <= innerWidth;
      }), 'Narrow role table layout is broken');
    }
  `)
})

test('disabled person status takes precedence over a retained lockout', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(fixture.clock.replace('/test/clock', '/v1/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic-ordinary', password: 'CANARY-wrong-password' }),
    })
    assert.equal(response.status, 401)
  }
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('.page-head').innerText.includes('Locked')), 'Initial lockout is missing');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=true]');
    check(await page.eval(() => document.querySelector('.page-head').innerText.includes('Disabled')), 'Lockout hides disabled status');
    check(await page.eval(() => [...document.querySelectorAll('.kv dt')].find(term => term.textContent === 'Locked').nextElementSibling.textContent.startsWith('Until ')), 'Lockout details were lost');
    await page.open(base + '/admin/users');
    check(await page.eval(() => document.querySelector('a[href="/admin/users/synthetic-ordinary"]').closest('tr').innerText.includes('Disabled')), 'List status disagrees with detail');
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    check(await page.eval(() => document.querySelector('.page-head').innerText.includes('Locked')), 'Re-enabling hides the retained lockout');
  `)
})

test('user detail can disable and re-enable sign-in', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=true]');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Enable…'), 'Disable was not saved');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=enabled][value=false]');
    check(await page.eval(() => document.querySelector('form:has([name=enabled]) button').textContent === 'Disable…'), 'Enable was not saved');
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
    const failures = () => [...document.querySelectorAll('.kv dt')].find(term => term.textContent === 'Failed sign-ins').nextElementSibling.textContent;
    check(await page.eval(failures) === '5' && await page.eval(() => document.querySelector('.page-head').innerText.includes('Locked')), 'Lockout was not shown');
    await page.click('form[action$="/unlock"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="2"]');
    check(await page.eval(failures) === '0' && await page.eval(() => !document.querySelector('form[action$="/unlock"]')), 'Unlock did not clear attempts');
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
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic Role · SSO rule')), 'Rule access was not shown');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="2"]');
    check(await page.eval(() => document.querySelector('main').innerText.includes('falcon-axi') && document.querySelector('main').innerText.includes('Synthetic Role · SSO rule')), 'Saving empty direct roles removed rule access');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="3"]');
    check(await page.eval(() => document.querySelector('[name=roleIds][type=checkbox]').checked), 'Direct role was not saved alongside rule grant');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic Role · Direct, SSO rule')), 'Effective tools lost an overlapping grant origin');
    await page.open(base + '/admin/roles/synthetic-role');
    check(await page.eval(() => document.querySelector('a[href="/admin/users/synthetic-sso"]').closest('tr').innerText.match(/Direct|SSO rule/g).join() === 'Direct,SSO rule'), 'Role membership lost an overlapping grant origin');
    await page.open(base + '/admin/users/synthetic-sso');
    await page.click('[name=roleIds][type=checkbox]');
    await page.click('form[action$="/roles"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=expectedRevision][value="4"]');
    check(await page.eval(() => !document.querySelector('[name=roleIds][type=checkbox]').checked && document.querySelector('main').innerText.includes('Synthetic Role · SSO rule')), 'Removing direct role did not retain rule grant');
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    await page.fill('#confirmation [data-confirm-name-input]', 'synthetic-sso');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/users"]');
    await page.open(base + '/admin/users/synthetic-sso');
    check(await page.eval(() => document.querySelector('main').innerText.includes('Synthetic Role · SSO rule')
      && document.querySelector('main').innerText.includes('From Entra ID rule')
      && !document.querySelector('main form, main input')), 'Archived user lost read-only rule provenance');
  `)
})

test('user detail resets a password and the person must change it at sign-in', () => {
  browser(`
    await page.open(base + '/admin/users/synthetic-ordinary');
    await page.click('.more-menu summary');
    await page.click('a[data-sheet="sheet-reset-password"]');
    await page.wait('#sheet-reset-password[open]');
    await page.fill('[name=temporaryPassword]', 'CANARY-reset-password');
    check(await page.eval(() => document.querySelector('#sheet-reset-password [name=temporaryPassword]').type === 'password'
      && !document.querySelector('#sheet-reset-password [data-generate-password]')), 'Reset password must keep manual passwords masked');
    await page.click('form[action$="/password-reset"] button:not([type=button])');
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

test('role and member tables align columns on desktop and stack readable rows on narrow screens', () => {
  for (const width of [1280, 420]) {
    chrome(['resize', String(width), '900'])
    browser(`
      for (const path of ['/admin/roles', '/admin/roles/synthetic-role']) {
        await page.open(base + path);
        check(await page.eval(() => {
          const table = document.querySelector('table');
          const headings = [...table.tHead.rows[0].cells];
          const rows = [...table.tBodies[0].rows];
          return rows.every(row => [...row.cells].every((cell, index) => {
            const bounds = cell.getBoundingClientRect();
            if (innerWidth > 760) {
              const heading = headings[index].getBoundingClientRect();
              return Math.abs(bounds.left - heading.left) < 1 && Math.abs(bounds.right - heading.right) < 1;
            }
            return index === 0 || bounds.width === 0 || bounds.top >= row.cells[0].getBoundingClientRect().bottom;
          })) && document.documentElement.scrollWidth <= innerWidth;
        }), 'Table layout broke on ' + path + ' at width ' + ${width});
      }
    `)
  }
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
    await page.click('section:has(h2):has(table caption) tbody form[action$="/revoke"] button');
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
    await page.click('section.card form[action$="/sessions/revoke"] button');
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
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('#confirmation button[value=confirmed]').disabled), 'Archive did not require the typed username');
    await page.fill('#confirmation [data-confirm-name-input]', 'synthetic-ordinar');
    check(await page.eval(() => document.querySelector('#confirmation button[value=confirmed]').disabled), 'Archive accepted a partial username');
    await page.click('#confirmation button[value=cancel]');
    check(await page.eval(() => !!document.querySelector('form[action$="/archive"]')), 'Cancel changed the user');
    await page.click('form[action$="/archive"] button');
    await page.wait('#confirmation[open]');
    await page.fill('#confirmation [data-confirm-name-input]', 'synthetic-ordinary');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('form[action="/v1/admin/users"]');
    check(await page.eval(() => !document.querySelector('tbody a[href="/admin/users/synthetic-ordinary"]')), 'Archived user remains in table');
    await page.open(base + '/admin/users/synthetic-ordinary');
    check(await page.eval(() => document.querySelector('main').innerText.includes('history is retained')), 'Archived state is missing');
    check(await page.eval(() => !document.querySelector('main form, main input')), 'Archived detail offers editing controls');
    check(await page.eval(() => document.querySelector('main a.chip').textContent === 'Synthetic Role · Direct'
      && document.querySelector('.card-meta').innerText.includes('Revision 2.')), 'Archived detail lost roles or change history');
    check(await page.eval(async () => {
      const response = await fetch('/v1/admin/users/synthetic-ordinary');
      return (await response.json()).roleIds.join(',') === 'synthetic-role';
    }), 'Archived detail changed retained membership');
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
    await page.click('details.disclosure > summary');
    check(await page.eval(() => {
      const text = document.querySelector('main').innerText;
      return text.includes('Live malware: this archive may contain executable malware. Save only; do not extract or execute. Password protection is unverified; bytes are saved exactly as provided.')
        && text.includes('artium-axi download --help') && text.includes('250 MiB')
        && text.includes('Missing verified-save receipt remains unconfirmed.')
        && !document.querySelector('a[href^="/v1/transfers/"]');
    }), 'Archive guidance lost its warning, limits, receipt distinction or CLI-only save boundary');
    check(await page.eval(() => document.querySelector('.tool-grid').innerText.includes('CrowdStrike Falcon')), 'Granted tools are missing');
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
    check(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), 'Account page overflows the page');
    await page.click('form[action^="/v1/account/sessions/"]:not([action="/v1/account/sessions/revoke"]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=username]');
    check(await page.eval(() => location.pathname === '/login'), 'Revoked browser retained access');
  `)
})
