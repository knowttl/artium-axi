import { test } from 'node:test'
import { useAdminBrowser } from './harness.mjs'

const { browser } = useAdminBrowser('submit-pipeline')

const keepSent = `
  await page.eval(() => {
    sessionStorage.removeItem('test-sent');
    const send = window.fetch;
    window.fetch = (input, init) => {
      if (init && init.body) sessionStorage.setItem('test-sent', JSON.stringify([...JSON.parse(sessionStorage.getItem('test-sent') || '[]'), [init.method, new URL(String(input), location.href).pathname, JSON.parse(init.body)]]));
      return send(input, init);
    };
  });
`
const sentRequests = "JSON.parse(await page.eval(() => sessionStorage.getItem('test-sent') || '[]'))"
const confirm = `
  await page.wait('#confirmation[open]');
  await page.click('#confirmation button[value=confirmed]');
`
const confirmAndWaitForSuccess = `
  ${confirm}
  await page.wait('.astryx-toast:not([data-type=error])');
  check(await page.eval(() => document.querySelector('.astryx-toast:not([data-type=error])').textContent === 'Change saved.'), 'The form did not report a successful save');
`
const readSettings = `
  const readSettings = path => page.eval('() => (' + (async path => {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Settings request failed with HTTP ' + response.status);
    return response.json();
  }).toString() + ')(' + JSON.stringify(path) + ')');
`
const toolApi = '/v1/admin/tools/falcon-axi'
const roleApi = '/v1/admin/roles/synthetic-role'
const routes = 'form[action$="/raw-api/routes"]'

test('route patterns are sent as trimmed lines with the revision as a number', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi?tab=raw-api');
    ${readSettings}
    const initial = await readSettings('${toolApi}');
    ${keepSent}
    await page.fill('${routes} [name=write]', 'PATCH items/*\\n  POST items  \\n\\n');
    await page.fill('${routes} [name=get]', 'items/**');
    await page.click('${routes} button');
    ${confirmAndWaitForSuccess}
    const sent = ${sentRequests};
    check(sent.length === 1 && sent[0][0] === 'PUT' && sent[0][1] === '/v1/admin/tools/falcon-axi/raw-api/routes', 'The request has the wrong method or URL: ' + JSON.stringify(sent));
    const body = sent[0][2];
    const expected = { write: ['PATCH items/*', 'POST items'], get: ['items/**'] };
    check(body.expectedRevision === initial.revision && JSON.stringify([body.write, body.get]) === JSON.stringify([expected.write, expected.get]), 'The request body is not shaped: ' + JSON.stringify(body));
    const saved = await readSettings('${toolApi}');
    check(saved.revision === initial.revision + 1 && JSON.stringify([saved.rawApi.routes.write, saved.rawApi.routes.get]) === JSON.stringify([expected.write, expected.get]), 'The route patterns did not persist: ' + JSON.stringify(saved.rawApi.routes));
  `)
})

test('one chosen option of a multi-select form is still sent as an array', () => {
  browser(`
    await page.open(base + '/admin/roles/synthetic-role');
    ${readSettings}
    const initial = await readSettings('${roleApi}');
    ${keepSent}
    await page.eval(() => {
      for (const box of document.querySelectorAll('form[action$="/synthetic-role/tools"] input[name=tools]:checked')) if (box.value !== 'falcon-axi') box.click();
    });
    await page.click('form[action$="/synthetic-role/tools"] button[type=submit]');
    ${confirmAndWaitForSuccess}
    const sent = ${sentRequests};
    check(sent.length === 1 && sent[0][2].expectedRevision === initial.revision && JSON.stringify(sent[0][2].tools) === '["falcon-axi"]', 'The chosen tool or revision was sent incorrectly: ' + JSON.stringify(sent));
    const saved = await readSettings('${roleApi}');
    check(saved.revision === initial.revision + 1 && JSON.stringify(saved.tools) === '["falcon-axi"]', 'The tool grants did not persist: ' + JSON.stringify(saved.tools));
  `)
})

test('invalid JSON in a plain form is reported and nothing is sent', () => {
  browser(`
    await page.open(base + '/admin/ssh');
    ${keepSent}
    const form = 'form[action="/v1/admin/ssh/hosts"]:has([name=expectedRevision][value="0"])';
    await page.fill(form + ' [name=id]', 'synthetic-new-host');
    await page.fill(form + ' [name=address]', '127.0.0.1');
    await page.fill(form + ' [name=approvedHostKeys]', 'not json');
    await page.fill(form + ' [name=independentVerification]', 'synthetic reference');
    await page.click(form + ' button');
    ${confirm}
    await page.wait('.astryx-toast[data-type=error]');
    check(await page.eval(() => document.querySelector('.astryx-toast[data-type=error]')?.textContent === 'Enter valid JSON in approvedHostKeys.'), 'The invalid JSON was not reported');
    check((${sentRequests}).length === 0, 'A request was sent with invalid JSON');
  `)
})
