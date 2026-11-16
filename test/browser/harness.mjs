import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { after, afterEach, before, beforeEach } from 'node:test'

// Starts the fake service, signs the synthetic administrator in and hands each test a browser session script runner.
export function useAdminBrowser(name) {
  const environment = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `artium-${name}-${process.pid}`, CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--ignore-certificate-errors' }
  let server
  let base = ''

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
      base = JSON.parse(line).url
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

  return { browser, url: () => base }
}
