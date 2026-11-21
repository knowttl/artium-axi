import { test } from 'node:test'
import { useAdminBrowser } from './harness.mjs'

const { browser, advanceClock } = useAdminBrowser('confirmations')

const keepRequests = `
  await page.eval(() => {
    sessionStorage.clear();
    window.draft = 'kept';
    window.dialogs = 0;
    document.addEventListener('artium-confirm', () => { window.dialogs += 1; });
    const send = window.fetch;
    window.fetch = async (input, init) => {
      const response = await send(input, init);
      if (!init || !init.body) return response;
      const sent = JSON.parse(sessionStorage.getItem('test-sent') || '[]');
      sent.push([init.method, new URL(String(input), location.href).pathname, JSON.parse(init.body), response.status, window.draft, window.dialogs]);
      sessionStorage.setItem('test-sent', JSON.stringify(sent));
      return response;
    };
  });
`

const record = `
  await page.eval(() => {
    window.sent = [];
    const send = window.fetch;
    window.fetch = (input, init) => { window.sent.push([String(input instanceof Request ? input.url : input), init && init.method, init && init.body]); return send(input, init); };
  });
`
const blocked = "(button => button.disabled || button.getAttribute('aria-disabled') === 'true')"
const enable = 'form:has([name=enabled]) button'

test('a tier 2 confirmation names the action and consequence, and Cancel sends nothing and returns focus to the control', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    ${record}
    await page.click('${enable}');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => {
      const dialog = document.querySelector('#confirmation');
      return dialog.querySelector('h2').innerText === 'Enabled?' && dialog.innerText.includes('Enable this tool for people whose roles grant access?')
        && JSON.stringify([...dialog.querySelectorAll('button')].map(button => [button.value, button.innerText, ${blocked}(button)])) === '[["cancel","Cancel",false],["confirmed","Enabled",false]]'
        && !dialog.querySelector('input')?.checkVisibility();
    }), 'The tier 2 dialog does not name its action, consequence and buttons');
    check(await page.eval(() => document.activeElement === document.querySelector('#confirmation button[value=cancel]')), 'Cancel does not hold the initial focus');
    await page.click('#confirmation button[value=cancel]');
    await page.wait('#confirmation:not([open])');
    check(await page.eval(() => window.sent.length === 0), 'Cancel sent a request');
    check(await page.eval(() => document.activeElement === document.querySelector('${enable}') && !document.activeElement.disabled), 'Focus did not return to the enabled triggering control');
  `)
})

test('Escape cancels a confirmation, a backdrop press does not, and the dialog never sends anything unconfirmed', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    ${record}
    await page.click('${enable}');
    await page.wait('#confirmation[open]');
    await page.eval(() => {
      const dialog = document.querySelector('#confirmation');
      for (const type of ['pointerdown', 'pointerup', 'click']) dialog.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 1, clientY: 1 }));
    });
    check(await page.eval(() => document.querySelector('#confirmation').open), 'A backdrop press closed the confirmation');
    await page.press('Escape');
    await page.wait('#confirmation:not([open])');
    check(await page.eval(() => window.sent.length === 0), 'Escape sent a request');
    check(await page.eval(() => document.activeElement === document.querySelector('${enable}') && !document.activeElement.disabled), 'Focus did not return after Escape');
  `)
})

test('confirming a tier 2 action sends exactly one request with the method, URL, CSRF token and revision of the form', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.eval(() => {
      const send = window.fetch;
      window.fetch = (input, init) => { sessionStorage.setItem('test-sent', JSON.stringify([...JSON.parse(sessionStorage.getItem('test-sent') || '[]'), [String(input instanceof Request ? input.url : input), init && init.method, init && init.body]])); return send(input, init); };
    });
    const expected = await page.eval(() => {
      const form = document.querySelector('form:has([name=enabled])');
      return { csrf: form.elements._csrf.value, revision: Number(form.elements.expectedRevision.value), confirmation: form.dataset.confirmToken };
    });
    await page.click('${enable}');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.astryx-toast, #toast:not(:empty)');
    const sent = JSON.parse(await page.eval(() => sessionStorage.getItem('test-sent')));
    check(sent.length === 1 && sent[0][1] === 'PATCH' && new URL(sent[0][0], base).pathname === '/v1/admin/tools/falcon-axi', 'The request has the wrong method or URL: ' + JSON.stringify(sent));
    const body = JSON.parse(sent[0][2]);
    check(JSON.stringify(Object.keys(body).sort()) === '["_confirm","_csrf","enabled","expectedRevision"]' && body._csrf === expected.csrf && body._confirm === expected.confirmation
      && body.expectedRevision === expected.revision && body.enabled === true, 'The request body differs from the form: ' + sent[0][2]);
  `)
})

const withoutScripts = `
  await page.eval(async () => {
    const html = (await (await fetch(location.href)).text()).replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/g, '');
    document.open(); document.write(html); document.close();
  });
`
const signOutEverywhere = 'form[action="/v1/account/sessions/revoke"] button'

test('a tier 2 form submitted before the page script runs gets the server confirmation step, and Cancel changes nothing', () => {
  browser(`
    await page.open(base + '/account');
    ${withoutScripts}
    check(await page.eval(() => document.scripts.length === 0), 'The page script was not held back');
    await page.click('${signOutEverywhere}');
    await page.wait('form[action="/v1/account/sessions/revoke"] [name=_confirm]');
    check(await page.eval(() => location.pathname === '/v1/account/sessions/revoke' && document.querySelector('h1').innerText === 'Sign out everywhere'
      && document.body.innerText.includes('Sign out all') && [...document.querySelectorAll('a, button')].some(item => item.innerText.trim() === 'Cancel')), 'The confirmation step does not show the action and consequence');
    await page.click('a[href="/account"]');
    await page.wait('nav[aria-label=Administration]');
    await page.open(base + '/admin');
    check(await page.eval(() => location.pathname === '/admin'), 'Cancel signed the person out');
  `)
})

test('confirming the server step finishes the action the unconfirmed submit only asked for', () => {
  browser(`
    await page.open(base + '/account');
    ${withoutScripts}
    await page.click('${signOutEverywhere}');
    await page.wait('form[action="/v1/account/sessions/revoke"] [name=_confirm]');
    await page.click('form[action="/v1/account/sessions/revoke"] button:last-of-type');
    await page.wait(1000);
    await page.open(base + '/admin');
    check(await page.eval(() => location.pathname === '/login'), 'Confirming the step did not sign the person out');
  `)
})

test('a tier 3 confirmation enables its button only for the exact typed name, and Cancel sends nothing', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi/instances/lab');
    ${record}
    await page.click('form[data-confirm-name] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => {
      const dialog = document.querySelector('#confirmation');
      const confirm = dialog.querySelector('[data-confirm-button]');
      return dialog.querySelector('h2').innerText === 'Delete instance' && dialog.innerText.includes('Delete lab? Its credential, certificate trust and health are removed.')
        && dialog.innerText.includes('Type lab to confirm') && confirm.innerText === 'Delete' && ${blocked}(confirm)
        && document.activeElement === document.querySelector('#confirmation-name');
    }), 'The tier 3 dialog does not ask for the name or disable its button');
    for (const wrong of ['la', 'LAB', 'lab ', 'labs']) {
      await page.fill('#confirmation-name', wrong);
      check(await page.eval(() => ${blocked}(document.querySelector('[data-confirm-button]'))), 'The button enabled for ' + JSON.stringify(wrong));
    }
    await page.fill('#confirmation-name', 'lab');
    check(await page.eval(() => !${blocked}(document.querySelector('[data-confirm-button]'))), 'The button stayed disabled for the exact name');
    await page.click('#confirmation button[value=cancel]');
    await page.wait('#confirmation:not([open])');
    check(await page.eval(() => window.sent.length === 0 && document.activeElement === document.querySelector('form[data-confirm-name] button')), 'Cancel sent a request or lost focus');
    await page.click('form[data-confirm-name] button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => document.querySelector('#confirmation-name').value === '' && ${blocked}(document.querySelector('[data-confirm-button]'))), 'A reopened dialog kept the previous name');
  `)
})

test('a tier 1 action sends its request at once with no confirmation', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi/instances/lab');
    ${record}
    await page.click('form[data-test-tool] button');
    await page.wait('[data-test-result]:not(:empty)');
    check(await page.eval(() => window.sent.length === 1 && window.sent[0][1] === 'POST' && new URL(window.sent[0][0], location.href).pathname === '/v1/admin/tools/falcon-axi/instances/lab/test' && !document.querySelector('#confirmation').open), 'The tier 1 action asked for confirmation or sent the wrong request');
  `)
})

test('confirming a tier 3 action sends the typed name with its one request and completes it', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi/instances/lab');
    ${keepRequests}
    await page.click('form[data-confirm-name] button');
    await page.wait('#confirmation[open]');
    await page.fill('#confirmation-name', 'lab');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.astryx-toast');
    const sent = JSON.parse(await page.eval(() => sessionStorage.getItem('test-sent')));
    check(sent.length === 1 && sent[0][0] === 'DELETE' && sent[0][1] === '/v1/admin/tools/falcon-axi/instances/lab' && sent[0][3] === 200, 'The tier 3 request is wrong: ' + JSON.stringify(sent));
    check(sent[0][2]._confirmName === 'lab' && /^\\d+\\.[\\w-]+$/.test(sent[0][2]._confirm), 'The tier 3 request lacks the typed name or the confirmation: ' + JSON.stringify(sent[0][2]));
  `)
})

test('a confirmation that lapsed while the form stayed open is replaced once and the same request is retried with the draft untouched', async () => {
  browser(`
    await page.open(base + '/account');
    ${keepRequests}
  `)
  await advanceClock(20)
  browser(`await page.eval(async () => { await fetch(location.href); });`)
  await advanceClock(20)
  browser(`
    await page.click('form[action="/v1/account/sessions/revoke"] button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('[name=username]');
    const sent = JSON.parse(await page.eval(() => sessionStorage.getItem('test-sent')));
    check(sent.length === 2 && sent.every(item => item[0] === 'POST' && item[1] === '/v1/account/sessions/revoke'), 'Expected exactly two POST requests: ' + JSON.stringify(sent));
    check([sent[0][3], sent[1][3]].join() === '428,200' && sent[0][2]._confirm !== sent[1][2]._confirm, 'The retry did not carry a fresh confirmation: ' + JSON.stringify(sent));
    check(sent[1][4] === 'kept' && sent[1][5] === 1, 'The page was reloaded or the dialog reopened before the retry: ' + JSON.stringify(sent));
  `)
})

for (const lastStatus of [200, 428]) test(`a lapsed confirmation after reauthentication is retried once when the retry returns ${lastStatus}`, () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.eval(() => {
      sessionStorage.removeItem('retry-requests');
      const send = window.fetch;
      window.fetch = async (input, init) => {
        if (new URL(String(input), location.href).pathname !== '/v1/admin/tools/falcon-axi') return send(input, init);
        const requests = JSON.parse(sessionStorage.getItem('retry-requests') || '[]');
        requests.push(JSON.parse(init.body));
        sessionStorage.setItem('retry-requests', JSON.stringify(requests));
        if (requests.length === 1) return Response.json({ error: { code: 'REAUTH_REQUIRED' } }, { status: 401 });
        if (requests.length === 2 || ${lastStatus} === 428) return Response.json({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirm again', next: 'Reload' } },
          { status: 428, headers: { 'x-artium-confirmation': requests.length === 2 ? 'fresh-value' : 'another-value' } });
        return Response.json({});
      };
    });
    await page.click('${enable}');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('#reauth-dialog[open]');
    await page.fill('#reauth-dialog [name=password]', 'CANARY-browser-password');
    await page.click('#reauth-dialog button:not([type=button])');
    await page.wait('${lastStatus === 200 ? '.astryx-toast, #toast:not(:empty)' : '.astryx-toast[data-type=error]'}');
    const requests = JSON.parse(await page.eval(() => sessionStorage.getItem('retry-requests')));
    check(requests.length === 3, 'Expected exactly three action requests: ' + JSON.stringify(requests));
    check(requests[0]._confirm === requests[1]._confirm && requests[2]._confirm === 'fresh-value', 'The retry did not use the fresh confirmation: ' + JSON.stringify(requests));
  `)
})

test('a tier 3 form is inert before the page script runs and changes nothing', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi/instances/lab');
    ${withoutScripts}
    check(await page.eval(() => document.scripts.length === 0), 'The page script was not held back');
    check(await page.eval(() => document.querySelector('form[data-confirm-name] button').matches(':disabled')), 'The tier 3 form accepted a submit before the page script');
    await page.click('form[data-confirm-name] button');
    check(await page.eval(() => location.pathname === '/admin/tools/falcon-axi/instances/lab'), 'The inert form navigated');
    await page.open(base + '/admin/tools/falcon-axi/instances/lab');
    await page.wait('form[data-confirm-name]');
  `)
})
