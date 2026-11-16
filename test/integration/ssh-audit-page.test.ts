import { mkdtempSync, rmSync } from 'node:fs'
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
import { encryptCredential } from '../../src/server/store/crypto.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { seedToolUser } from '../fixtures/tokens.js'

type Element = DefaultTreeAdapterMap['element']

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
const owner = 'synthetic-development-user'
const sample = '<script>synthetic-untrusted-output</script>'
const day = 86400000
const yesterday = Math.floor(Date.now() / day) * day - day
const credentialSecret = 'CANARY-ssh-page-private-key'
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ssh-audit-page-'))
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  const store = createCredentialStore(db, provider)
  const hosts = new SshHosts(db, provider)
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner: await Runner.create(join(directory, 'calls')), credentialStore: store, sshHosts: hosts,
    sshExecution: { provider, writeLog: join(directory, 'writes.log'), executable: join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js') },
    resolver: new SharedIdentityResolver(store, db), adapters: [], environment: {} })
  db.exec(`INSERT INTO ssh_hosts (id,address,port,approved_host_keys,allowed_addresses,enabled,read_only)
    VALUES ('synthetic-host','127.0.0.1',22,'["ssh-ed25519 YWJj"]','["127.0.0.1"]',1,0)`)
  hosts.replaceCredential('ordinary-key', { privateKey: credentialSecret }, 0, owner)
  headers = { host: 'localhost', origin: 'http://localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

function retain(id: string, startedAt: number, outcome = 'completed', metadata: object = { remoteExit: 0 }) {
  const family = db.prepare('SELECT id FROM session_families WHERE user_id=?').get(owner) as { id: string } | undefined
  db.prepare(`INSERT INTO ssh_executions VALUES (?,?,?,?,?,'synthetic-host','ordinary','fixture-binding','printf synthetic',0,'fixture-request',?,?,?,?)`)
    .run(id, `key-${id}`, `input-${id}`, owner, family?.id ?? 'family', startedAt, startedAt + 1000, outcome, JSON.stringify(metadata))
}
function retainOutput(id: string, output: object) {
  const encrypted = encryptCredential(id, 'ssh-axi', Buffer.from(JSON.stringify(output)), provider.getKey())
  db.prepare(`INSERT INTO ssh_execution_results (id,tool,schema_version,key_id,nonce,ciphertext,authentication_tag,updated_at)
    VALUES (@id,@tool,@schema_version,@key_id,@nonce,@ciphertext,@authentication_tag,@now)`).run({ ...encrypted, now: Date.now() })
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const words = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? words(child) : '').join(' ').replace(/\s+/g, ' ').trim()
const page = async (query = '') => {
  const response = await app.inject({ url: '/admin/ssh/audit' + query, headers })
  const all = nodes(parse(response.body))
  const table = (label: string) => all.find(element => element.tagName === 'table' && attribute(element, 'aria-label') === label)
  const rows = (label: string) => nodes(table(label)!).filter(element => element.tagName === 'tr').slice(1).map(row =>
    row.childNodes.filter((child): child is Element => 'tagName' in child).map(words))
  return { response, all, table, rows,
    link: (text: string) => all.find(element => element.tagName === 'a' && words(element) === text),
    executions: all.filter(element => element.tagName === 'article' && attribute(element, 'class') === 'execution') }
}

test('the audit page shows retained untrusted output as inert text and never as markup', async () => {
  retain('exec_fixture', yesterday)
  retainOutput('exec_fixture', { stdout: { text: sample, receivedBytes: 43, retainedBytes: 43 } })
  const { response, all, executions } = await page()
  expect(response.statusCode).toBe(200)
  expect(response.body).not.toContain(sample)
  expect(all.filter(element => element.tagName === 'script' && attribute(element, 'src') === undefined && attribute(element, 'type') !== 'application/json')).toEqual([])
  expect(executions).toHaveLength(1)
  expect(nodes(executions[0]!).filter(element => element.tagName === 'pre').map(words)).toContain(sample)
})

test('an execution shows who ran what where, with its outcome and exit', async () => {
  retain('exec_fixture', yesterday, 'failed', { remoteExit: 3, diagnostic: 'Synthetic diagnostic' })
  const { executions } = await page()
  const text = words(executions[0]!)
  expect(text).toContain('exec_fixture')
  expect(text).toContain('Failed')
  for (const fact of ['Host synthetic-host', 'Account ordinary', 'Remote exit 3', 'Request ID fixture-request', 'printf synthetic', 'Synthetic diagnostic']) expect(text).toContain(fact)
})

test('connection events and denials are listed with their columns', async () => {
  const family = db.prepare('SELECT id FROM session_families WHERE user_id=?').get(owner) as { id: string } | undefined
  db.prepare(`INSERT INTO ssh_connection_events (connection_id,user_id,family_id,host_id,sudo,event,occurred_at,binding) VALUES ('connection-1',?,?,'synthetic-host',1,'opened',?, 'binding-1')`)
    .run(owner, family?.id ?? 'family', yesterday + 1000)
  new Audit(db, () => yesterday + 2000, () => {}).record({ event: 'denial', userId: owner, tool: 'ssh-axi', outcome: 'PERMISSION_DENIED', requestId: 'denied-request', clientAddress: null })
  const { rows } = await page()
  expect(rows('Connection events')).toEqual([[new Date(yesterday + 1000).toISOString(), 'opened Sudo', 'synthetic-host', owner, `connection-1 Session family ${family?.id ?? 'family'} Binding binding-1`]])
  expect(rows('Denials')).toEqual([[new Date(yesterday + 2000).toISOString(), owner, 'denied-request', 'PERMISSION_DENIED']])
})

test('with nothing retained the page says so and offers no older link', async () => {
  const { all, link } = await page()
  expect(all.map(words)).toContain('No retained SSH executions.')
  expect(link('Older executions')).toBeUndefined()
})

test('a full page links to older executions from its cursor and the export link keeps the query', async () => {
  for (let index = 0; index < 51; index++) retain(`exec_${String(index).padStart(2, '0')}`, yesterday + index)
  const first = await page()
  expect(first.executions).toHaveLength(50)
  const older = attribute(first.link('Older executions')!, 'href')!
  expect(older).toMatch(/^\/admin\/ssh\/audit\?before=\d+$/)
  const second = await page(older.slice('/admin/ssh/audit'.length))
  expect(second.executions.map(execution => words(execution))).toHaveLength(1)
  expect(attribute((await page('?id=exec_00')).link('Export this page (metadata only)')!, 'href')).toBe('/v1/admin/ssh/audit/export?id=exec_00')
})

test('opening the page is audited and a saved SSH credential never appears in it', async () => {
  retain('exec_fixture', yesterday)
  const { response } = await page()
  expect(response.body).not.toContain(credentialSecret)
  expect(db.prepare("SELECT action FROM audit WHERE action = 'ssh-audit-read'").all()).toEqual([{ action: 'ssh-audit-read' }])
})

test('the page is titled SSH audit and offers the Tools help', async () => {
  const { response } = await page()
  expect(response.body).toContain('<title>SSH audit - artium-axi</title>')
  expect(response.body).toContain('Open a tool, add an instance, test it')
})

test('people who are not administrators are refused', async () => {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, must_change) VALUES ('ordinary-user', 'ordinary-user', 'Ordinary User', 'CANARY-hash', 0)").run()
  const ordinary = { ...headers, cookie: `${browserCookie}=${createBrowserSession(db, 'ordinary-user', 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
  const refused = await app.inject({ url: '/admin/ssh/audit', headers: ordinary })
  expect(refused.statusCode).toBe(403)
  expect(refused.body).not.toContain('exec_fixture')
})

test.each([['/admin/ssh', 'ssh-hosts-legacy.html'], ['/admin/ssh/credentials', 'ssh-credentials-legacy.html']])('%s still renders its legacy markup until its own rebuild', async (url, fixture) => {
  db.exec(`INSERT INTO ssh_bindings (host_id,username,credential_id,sudo) VALUES ('synthetic-host','ordinary','ordinary-key',0);
    INSERT INTO ssh_grants (user_id,host_id,shell,sudo) VALUES ('${owner}','synthetic-host',1,0)`)
  const response = await app.inject({ url, headers })
  const main = response.body.match(/<main id="main".*?<\/main>/s)![0].replace(/(name="_csrf" value=")[^"]*/g, '$1CSRF')
  await expect(main).toMatchFileSnapshot(`../fixtures/${fixture}`)
})
