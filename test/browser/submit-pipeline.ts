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

test('a pre-hydration submission confirms and saves the original draft after edits', () => {
  browser(`
    const within = (promise, message) => {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); });
      return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
    };
    const inFrame = fn => page.eval('() => (' + fn.toString() + ')(' + within.toString() + ')');
    await page.open(base + '/admin/tools/falcon-axi');
    ${readSettings}
    const initial = await readSettings('${toolApi}');
    await inFrame(async within => {
      const html = (await (await fetch(location.href)).text()).replace(/<script\\b[^>]*hydrate\\.js[^>]*><\\/script>/, '');
      const frame = document.createElement('iframe');
      frame.srcdoc = html;
      const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
      document.body.append(frame);
      await within(loaded, 'The server-rendered frame did not load');
      const win = frame.contentWindow;
      win.dialogs = 0;
      win.document.addEventListener('artium-confirm', () => { win.dialogs += 1; });
      win.submission = Promise.withResolvers();
      const send = win.fetch;
      win.fetch = async (input, init) => {
        if (!init?.body) return send(input, init);
        win.sent = true;
        const response = await send(input, init);
        win.submission.resolve({ method: init.method, body: JSON.parse(init.body), status: response.status });
        return response;
      };
      const form = win.document.querySelector('form:has([name=enabled])');
      form.querySelector('button').click();
      form.elements.enabled.value = 'false';
      form.elements.expectedRevision.value = '999';
      form.elements._csrf.value = 'edited-csrf';
    });
    check(await page.eval(() => {
      const win = document.querySelector('iframe').contentWindow;
      return win.dialogs === 0 && !win.document.querySelector('#confirmation[open]') && !win.sent;
    }), 'The form was handled before the page hydrated');
    const { method, body, status } = await inFrame(async within => {
      const win = document.querySelector('iframe').contentWindow;
      const dialog = win.document.querySelector('#confirmation');
      const script = win.document.createElement('script');
      script.src = '/admin/assets/hydrate.js';
      const loaded = new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('The hydration script failed to load'));
      });
      win.document.head.append(script);
      await within(loaded, 'The hydration script did not load');
      let observer;
      try {
        await within(new Promise(resolve => {
          if (dialog.open) return resolve();
          observer = new MutationObserver(() => { if (dialog.open) resolve(); });
          observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
        }), 'The deferred submit did not open confirmation');
      } finally {
        observer?.disconnect();
      }
      const submission = win.submission.promise;
      dialog.querySelector('button[value=confirmed]').click();
      return within(submission, 'The deferred submit did not receive a response');
    });
    check(method === 'PATCH' && body.enabled === true && body.expectedRevision === initial.revision && typeof body._confirm === 'string' && body._confirm.length > 0, 'The deferred submit did not send the confirmed original draft: ' + JSON.stringify(body));
    check(status === 200, 'The deferred submit failed with HTTP ' + status);
    const saved = await readSettings('${toolApi}');
    check(saved.enabled === true && saved.revision === initial.revision + 1, 'The deferred submit did not enable the tool');
  `)
})
