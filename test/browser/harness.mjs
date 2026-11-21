import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { after, afterEach, before, beforeEach } from 'node:test'

export const waitForReauthPills = `const waitForReauthPills = (expectedText, state, icon, timeoutMs = 5000) => page.eval('() => (' +
  ((expectedText, state, icon, timeoutMs) => {
    const matches = () => ['.frame-controls-header', '.frame-controls-drawer'].every(placement => {
      const pills = document.querySelectorAll(placement + ' [data-reauth-method]');
      const pill = pills[0];
      return pills.length === 1 && pill.className === 'unlock ' + state
        && pill.querySelector('use')?.getAttribute('href') === icon
        && pill.textContent === expectedText;
    });
    if (matches()) return;
    const fail = () => new Error('Expected one recent-authentication pill in each frame placement showing ' + expectedText + ', ' + state + ', ' + icon);
    if (timeoutMs === 0) throw fail();
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (!matches()) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(fail());
      }, timeoutMs);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
  }).toString() + ')(...' + JSON.stringify([expectedText, state, icon, timeoutMs]) + ')');`

export const waitForTime = `const waitForTime = async (selector, iso, expected) => {
  await page.wait(selector);
  expected ??= await page.eval('() => (' + (iso => {
    const instant = new Date(iso);
    const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(instant);
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(instant);
    return date + ', ' + time;
  }).toString() + ')(' + JSON.stringify(iso) + ')');
  const matches = await page.eval('() => (' + ((selector, iso, expected) => new Promise(resolve => {
    const matches = () => {
      const time = document.querySelector(selector);
      return time?.textContent === expected && time.dateTime === iso && time.title === iso;
    };
    const finish = value => {
      observer.disconnect();
      clearTimeout(timeout);
      resolve(value);
    };
    const observer = new MutationObserver(() => { if (matches()) finish(true); });
    const timeout = setTimeout(() => finish(false), 5000);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    if (matches()) finish(true);
  })).toString() + ')(...' + JSON.stringify([selector, iso, expected]) + ')');
  if (!matches) {
    const actual = await page.eval('() => document.querySelector(' + JSON.stringify(selector) + ')?.outerHTML');
    throw new Error(selector + ' did not render ' + expected + ' with datetime and tooltip ' + iso + '. Received ' + actual);
  }
};`

// Starts the fake service, signs the synthetic administrator in and hands each test a browser session script runner.
export function useAdminBrowser(name) {
  const environment = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `artium-${name}-${process.pid}`, CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--ignore-certificate-errors' }
  let server
  let base = ''
  let clock = ''

  const chrome = (args, input) => {
    const result = spawnSync('chrome-devtools-axi', args, { env: environment, input, encoding: 'utf8', timeout: 90_000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }

  const browser = script => chrome(['run'], `const base = ${JSON.stringify(base)};
    const check = (value, message) => { if (!value) throw new Error(message); };
    const wait = page.wait.bind(page);
    page.wait = async (...args) => {
      try { await wait(...args); }
      catch (error) {
        if (!error.message.includes('Execution context was destroyed')) throw error;
        await wait(...args);
      }
    };
    ${script}`)

  before(async () => {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    environment.CHROME_DEVTOOLS_AXI_PORT = String(reservation.address().port)
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  })

  beforeEach(async () => {
    server = spawn(process.execPath, ['test/fake-service/browser-auth.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const lines = createInterface({ input: server.stdout })
    try {
      const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
      ;({ url: base, clock } = JSON.parse(line))
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
    `)
  })

  afterEach(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
  })

  after(() => chrome(['stop']))

  const advanceClock = async minutes => {
    const response = await fetch(clock, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: minutes * 60_000 }) })
    assert.equal(response.status, 200)
  }

  return { browser, url: () => base, advanceClock }
}
