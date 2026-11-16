import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { seedToolUser } from '../fixtures/tokens.js'

type Element = DefaultTreeAdapterMap['element']

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let hosts: SshHosts
let headers: Record<string, string>
const owner = 'synthetic-development-user'
const secrets = { privateKey: 'CANARY-credentials-page-private-key', passphrase: 'CANARY-credentials-page-passphrase', password: 'CANARY-credentials-page-password' }
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ssh-credentials-page-'))
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  const store = createCredentialStore(db, provider)
  hosts = new SshHosts(db, provider)
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner: await Runner.create(join(directory, 'calls')), credentialStore: store, sshHosts: hosts,
    resolver: new SharedIdentityResolver(store, db), adapters: [], environment: {} })
  headers = { host: 'localhost', origin: 'http://localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const words = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? words(child) : '').join(' ').replace(/\s+/g, ' ').trim()
const page = async () => (await app.inject({ url: '/admin/ssh/credentials', headers })).body

const attributes = (element: Element) => Object.fromEntries(element.attrs.filter(item => item.name !== 'class').map(item => [item.name, item.value]))
const content = (html: string) => {
  const all = nodes(parse(html))
  const main = all.find(element => attribute(element, 'role') === 'main' || element.tagName === 'main')
  return main ? nodes(main) : all
}
const contract = (html: string) => {
  const all = content(html)
  return {
    forms: all.filter(element => element.tagName === 'form' && attribute(element, 'data-api') !== undefined).map((form): Record<string, unknown> => ({ ...attributes(form),
      buttons: nodes(form).filter(element => element.tagName === 'button').map(words),
      controls: nodes(form).filter(element => ['input', 'textarea', 'select'].includes(element.tagName) && attribute(element, 'name') !== '_csrf')
        .map((control): Record<string, unknown> => ({ tag: control.tagName, ...attributes(control), text: control.tagName === 'textarea' ? words(control) : undefined })) })),
    labels: all.filter(element => element.tagName === 'label' && attribute(element, 'for') !== undefined).map(label => [attribute(label, 'for'), words(label)]),
    hints: all.filter(element => attribute(element, 'id')?.endsWith('-hint')).map(hint => [attribute(hint, 'id'), words(hint)]),
    disclosures: all.filter(element => element.tagName === 'details' && attribute(element, 'name') !== undefined).map(details => [attribute(details, 'name'), attribute(details, 'open') !== undefined,
      words(nodes(details).find(element => element.tagName === 'summary')!)]),
  }
}

test('the rebuilt credential forms keep the recorded legacy forms: URLs, methods, confirmations, fields, labels, hints and attributes', async () => {
  hosts.replaceCredential('ordinary-key', { privateKey: secrets.privateKey }, 0, owner)
  const recorded = contract(readFileSync(join(process.cwd(), 'test/fixtures/ssh-credentials-legacy.html'), 'utf8'))
  expect(recorded.forms.map(form => form.action)).toEqual(['/v1/admin/ssh/credential', '/v1/admin/ssh/credential', '/v1/admin/ssh/credential-delete', '/v1/admin/ssh/credential', '/v1/admin/ssh/credential'])
  expect(contract(await page())).toEqual(recorded)
})

test('no secret field carries a value, and a saved key, passphrase or password is shown nowhere on the page', async () => {
  hosts.replaceCredential('key-credential', { privateKey: secrets.privateKey, passphrase: secrets.passphrase }, 0, owner)
  hosts.replaceCredential('password-credential', { password: secrets.password }, 0, owner)
  const body = await page()
  for (const secret of Object.values(secrets)) expect(body).not.toContain(secret)
  const fields = content(body).filter(element => ['privateKey', 'passphrase', 'password'].includes(attribute(element, 'name') ?? ''))
  expect(fields).toHaveLength(9)
  for (const field of fields) {
    expect(attribute(field, 'value')).toBeUndefined()
    expect(words(field)).toBe('')
    expect(attribute(field, 'autocomplete')).toMatch(/^(off|new-password)$/)
  }
})

test('the hydration data of the page carries stored credential ids and revisions only', async () => {
  hosts.replaceCredential('key-credential', { privateKey: secrets.privateKey }, 0, owner)
  const data = nodes(parse(await page())).find(element => attribute(element, 'data-astryx-props') !== undefined)!
  const props = JSON.parse(words(data)) as { props: { credentials: unknown[] } }
  expect(props.props.credentials).toEqual([{ id: 'key-credential', revision: 1 }])
})

test('with nothing stored only the new credential panel is offered, with both methods', async () => {
  const forms = contract(await page()).forms
  expect(forms.map(form => form.buttons)).toEqual([['Save credential'], ['Save credential']])
  expect(forms.map(form => (form.controls as Record<string, unknown>[]).map(control => control.name))).toEqual([['confirm', 'expectedRevision', 'id', 'privateKey', 'passphrase'], ['confirm', 'expectedRevision', 'id', 'password']])
})

test('the page is titled SSH credentials and offers the Tools help', async () => {
  const body = await page()
  expect(body).toContain('<title>SSH credentials - artium-axi</title>')
  expect(body).toContain('Open a tool, add an instance, test it')
})

test('the credentials page is refused to people who are not administrators', async () => {
  hosts.replaceCredential('key-credential', { privateKey: secrets.privateKey }, 0, owner)
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, must_change) VALUES ('ordinary-user', 'ordinary-user', 'Ordinary User', 'CANARY-hash', 0)").run()
  const ordinary = { ...headers, cookie: `${browserCookie}=${createBrowserSession(db, 'ordinary-user', 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
  const refused = await app.inject({ url: '/admin/ssh/credentials', headers: ordinary })
  expect(refused.statusCode).toBe(403)
  expect(refused.body).not.toContain('key-credential')
})
