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
const confirmAndWait = `
  await page.wait('#confirmation[open]');
  await page.click('#confirmation button[value=confirmed]');
  await page.wait('.astryx-toast');
`
const routes = 'form[action$="/raw-api/routes"]'

test('route patterns are sent as trimmed lines with the revision as a number', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi?tab=raw-api');
    ${keepSent}
    await page.fill('${routes} [name=write]', 'PATCH items/*\\n  POST items  \\n\\n');
    await page.fill('${routes} [name=get]', 'items/**');
    await page.click('${routes} button');
    ${confirmAndWait}
    const sent = ${sentRequests};
    check(sent.length === 1 && sent[0][0] === 'PUT' && sent[0][1] === '/v1/admin/tools/falcon-axi/raw-api/routes', 'The request has the wrong method or URL: ' + JSON.stringify(sent));
    const body = sent[0][2];
    check(JSON.stringify([body.write, body.get, typeof body.expectedRevision]) === '[["PATCH items/*","POST items"],["items/**"],"number"]', 'The request body is not shaped: ' + JSON.stringify(body));
  `)
})

test('one chosen option of a multi-select form is still sent as an array', () => {
  browser(`
    await page.open(base + '/admin/roles/synthetic-role');
    ${keepSent}
    await page.eval(() => {
      for (const box of document.querySelectorAll('form[action$="/synthetic-role/tools"] input[name=tools]:checked')) if (box.value !== 'falcon-axi') box.click();
    });
    await page.click('form[action$="/synthetic-role/tools"] button[type=submit]');
    ${confirmAndWait}
    const sent = ${sentRequests};
    check(sent.length === 1 && JSON.stringify(sent[0][2].tools) === '["falcon-axi"]', 'The chosen tool is not an array: ' + JSON.stringify(sent));
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
    ${confirmAndWait}
    check(await page.eval(() => document.querySelector('.astryx-toast[data-type=error]')?.textContent === 'Enter valid JSON in approvedHostKeys.'), 'The invalid JSON was not reported');
    check((${sentRequests}).length === 0, 'A request was sent with invalid JSON');
  `)
})

test('a form submitted before the page hydrates waits for hydration, then confirms and sends the shaped request', () => {
  browser(`
    const inFrame = fn => page.eval('() => (' + fn.toString() + ')()');
    await page.open(base + '/admin/tools/falcon-axi');
    await inFrame(async () => {
      sessionStorage.removeItem('test-sent');
      const html = (await (await fetch(location.href)).text()).replace(/<script\\b[^>]*hydrate\\.js[^>]*><\\/script>/, '');
      const frame = document.createElement('iframe');
      frame.srcdoc = html;
      document.body.append(frame);
      await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
      const win = frame.contentWindow;
      win.dialogs = 0;
      win.document.addEventListener('artium-confirm', () => { win.dialogs += 1; });
      const send = win.fetch;
      win.fetch = (input, init) => {
        if (init && init.body) sessionStorage.setItem('test-sent', JSON.stringify([init.method, JSON.parse(init.body)]));
        return send(input, init);
      };
      win.document.querySelector('form:has([name=enabled]) button').click();
    });
    check(await page.eval(() => {
      const win = document.querySelector('iframe').contentWindow;
      return win.dialogs === 0 && !win.document.querySelector('#confirmation[open]') && !sessionStorage.getItem('test-sent');
    }), 'The form was handled before the page hydrated');
    await inFrame(async () => {
      const win = document.querySelector('iframe').contentWindow;
      await new Promise(resolve => {
        const script = win.document.createElement('script');
        script.src = '/admin/assets/hydrate.js';
        script.onload = resolve;
        win.document.head.append(script);
      });
      while (!win.document.querySelector('#confirmation[open]')) await new Promise(resolve => setTimeout(resolve, 50));
      win.document.querySelector('#confirmation button[value=confirmed]').click();
      while (!sessionStorage.getItem('test-sent')) await new Promise(resolve => setTimeout(resolve, 50));
    });
    const [method, body] = JSON.parse(await page.eval(() => sessionStorage.getItem('test-sent')));
    check(method === 'PATCH' && body.enabled === true && typeof body.expectedRevision === 'number' && typeof body._confirm === 'string', 'The deferred submit did not send the confirmed, shaped request: ' + JSON.stringify(body));
  `)
})
