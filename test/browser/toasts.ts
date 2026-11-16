import { test } from 'node:test'
import { useAdminBrowser } from './harness.mjs'

const { browser } = useAdminBrowser('toasts')

const staleSave = `
  await page.eval(() => { document.querySelector('form:has([name=enabled]) [name=expectedRevision]').value = '999'; });
  await page.click('form:has([name=enabled]) button');
  await page.wait('#confirmation[open]');
  await page.click('#confirmation button[value=confirmed]');
`

test('a saved change announces its message politely after the page reloads, and the message is consumed', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    await page.click('#confirmation button[value=confirmed]');
    await page.wait('.astryx-toast');
    check(await page.eval(() => document.querySelector('.astryx-toast').textContent === 'Change saved.' && document.querySelector('.astryx-toast').dataset.type !== 'error'), 'The success toast is wrong');
    check(await page.eval(() => document.querySelector('[data-astryx-live-region=polite]').textContent === 'Change saved.' && document.querySelector('[data-astryx-live-region=assertive]').textContent === ''), 'The success was not announced politely');
    check(await page.eval(() => sessionStorage.getItem('artium-toast') === null && !document.querySelector('#toast, #message')), 'The saved message was kept or the old regions remain');
  `)
})

test('a rejected save announces its error assertively with a reload action, and the next submit clears it', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    ${staleSave}
    await page.wait('.astryx-toast[data-type=error]');
    check(await page.eval(() => {
      const toast = document.querySelector('.astryx-toast[data-type=error]');
      return toast.textContent.includes('(REVISION_CONFLICT)') && [...toast.querySelectorAll('button')].some(button => button.textContent === 'Reload latest');
    }), 'The error toast lacks its message or reload action');
    check(await page.eval(() => document.querySelector('[data-astryx-live-region=assertive]').textContent.includes('(REVISION_CONFLICT)') && document.querySelector('[data-astryx-live-region=polite]').textContent === ''), 'The error was not announced assertively');
    await page.click('form:has([name=enabled]) button');
    await page.wait('#confirmation[open]');
    check(await page.eval(() => !document.querySelector('.astryx-toast[data-type=error]')), 'Submitting again left the previous error showing');
  `)
})

test('a success and an error stack, and a server message renders as text', () => {
  browser(`
    await page.open(base + '/admin/tools/falcon-axi');
    await page.eval(() => sessionStorage.setItem('artium-toast', '<b id="injected">Synthetic saved</b>'));
    await page.open(base + '/admin/tools/falcon-axi');
    await page.wait('.astryx-toast');
    ${staleSave}
    await page.wait('.astryx-toast[data-type=error]');
    check(await page.eval(() => document.querySelectorAll('.astryx-toast').length === 2 && !document.querySelector('#injected')
      && document.querySelector('.astryx-toast:not([data-type=error])').textContent === '<b id="injected">Synthetic saved</b>'), 'The toasts did not stack as text');
  `)
})
