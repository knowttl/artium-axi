import { test } from 'node:test'
import { useAdminBrowser } from './harness.mjs'

const { browser } = useAdminBrowser('confirmations')

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
