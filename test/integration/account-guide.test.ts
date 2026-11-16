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
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { seedToolUser } from '../fixtures/tokens.js'

type Element = DefaultTreeAdapterMap['element']

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
const owner = 'synthetic-development-user'
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
const transfer = { transfer_id: 'f105c3b9-a58f-4d4c-bb60-8d17a70b5b86', session_family_id: 'family', transfer_operation: 'hash-download-bin' as const,
  artifact_type: 'bin' as const, artifact_selector: 'a'.repeat(64), requested_target_digest: 'b'.repeat(64), archive_bytes: null, archive_sha256: null,
  native_audit_id: null, native_journal_result: null, client_save_outcome: 'unconfirmed' as const }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-account-guide-'))
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  db.exec('DELETE FROM role_tools')
  const store = createCredentialStore(db, key)
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner: await Runner.create(join(directory, 'calls')), credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), adapters: [], environment: {} })
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

const grant = (...tools: string[]) => { for (const tool of tools) db.prepare("INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', ?)").run(tool) }
const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const words = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? words(child) : '').join(' ').replace(/\s+/g, ' ').trim()
async function account() {
  const response = await app.inject({ url: '/account', headers: { host: 'localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}` } })
  const all = nodes(parse(response.body))
  const panel = (title: string) => all.find(element => element.tagName === 'h2' && words(element) === title)
  return { response, all, panel, blocks: all.filter(element => element.tagName === 'pre').map(words),
    section: (heading: string) => all.find(element => element.tagName === 'h3' && words(element) === heading) }
}

test('the tools grid lists each granted tool with its availability, including tools an administrator turned off', async () => {
  grant('falcon-axi', 'vectra-axi')
  db.prepare("UPDATE tools SET enabled = 0 WHERE name = 'falcon-axi'").run()
  db.prepare("UPDATE tools SET enabled = 1 WHERE name = 'vectra-axi'").run()
  const { all } = await account()
  const items = nodes(all.find(element => element.tagName === 'ul' && attribute(element, 'class') === 'tool-grid')!).filter(element => element.tagName === 'li').map(words)
  expect(items).toEqual(['FA CrowdStrike Falcon Turned off by admin', 'VE Vectra Available'])
})

test('with no granted tool the page says so and offers no saving guidance', async () => {
  const { all, panel } = await account()
  expect(all.map(words)).toContain('No tools granted. Ask an administrator to assign a role that grants the tools you need.')
  expect(panel('Saving files from tools')).toBeUndefined()
  expect(all.filter(element => element.tagName === 'details' && attribute(element, 'class') === 'disclosure')).toEqual([])
})

test.each([
  ['local', "./artium-axi.mjs login --username 'synthetic-user'\n./artium-axi.mjs tools"],
  ['sso', './artium-axi.mjs login --sso\n./artium-axi.mjs tools'],
])('the CLI steps for a %s account offer the verified download, the sign-in command and a setup command per agent host', async (source, signIn) => {
  if (source === 'sso') db.prepare("UPDATE users SET source = 'sso', password_hash = NULL WHERE id = ?").run(owner)
  const { blocks, all } = await account()
  expect(blocks.slice(0, 2)).toEqual([[
    "export ARTIUM_AXI_URL='http://localhost'",
    'curl --fail --output artium-axi.mjs "$ARTIUM_AXI_URL/cli/artium-axi.mjs" &&',
    'curl --fail --output artium-axi.mjs.sha256 "$ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" &&',
    'sha256sum --check artium-axi.mjs.sha256 &&',
    'chmod 755 artium-axi.mjs'].join(' '), signIn.replace('\n', ' ')])
  const radios = all.filter(element => element.tagName === 'input' && attribute(element, 'name') === 'host')
  expect(radios.map(radio => [attribute(radio, 'value'), attribute(radio, 'checked') !== undefined])).toEqual([['claude', true], ['codex', false], ['opencode', false], ['pi', false]])
  expect(blocks.slice(2)).toEqual(['claude', 'codex', 'opencode', 'pi'].map(host => `./artium-axi.mjs setup --host ${host}`))
})

test('saving guidance appears for tools that save files, names only those tools, and lists the latest transfers', async () => {
  grant('hybrid-axi', 'checkpoint-axi', 'falcon-axi')
  new Audit(db, Date.now, () => {}).record({ event: 'transfer', userId: owner, tool: 'hybrid-axi', outcome: 'preview', credentialRevision: 1, transfer, requestId: 'transfer', clientAddress: null })
  const { all, section, blocks } = await account()
  const summary = all.find(element => element.tagName === 'summary' && words(element).startsWith('Saving files from tools'))!
  expect(words(summary).replace(' .', '.')).toBe('Saving files from tools Check Point Email, Hybrid Analysis. Saves happen only through the CLI on a controlled Linux host; the browser never handles the files.')
  expect(section('Hybrid Analysis archive saving')).toBeDefined()
  expect(section('Check Point email and attachment saving')).toBeDefined()
  expect(section('Microsoft Graph mail saving')).toBeUndefined()
  expect(section('BeyondTrust endpoint content saving')).toBeUndefined()
  expect(blocks).toContain('artium-axi download --operation report-download-bin --selector <report-id> --type bin --destination /controlled/artifacts/new-archive.bin')
  const table = all.find(element => element.tagName === 'table' && attribute(element, 'aria-label') === 'Your latest 20 archive transfers')!
  const row = nodes(table).filter(element => element.tagName === 'tr')[1]!
  expect(row.childNodes.filter((child): child is Element => 'tagName' in child).map(words)).toEqual(['hybrid-axi', 'bin', 'a'.repeat(64), 'Unknown', 'Unknown', 'Unknown', 'Unconfirmed', 'preview', 'unconfirmed'])
})

test('the saving examples of an SSO account carry the SSO flag', async () => {
  grant('hybrid-axi')
  db.prepare("UPDATE users SET source = 'sso', password_hash = NULL WHERE id = ?").run(owner)
  expect((await account()).blocks).toContain('artium-axi download --operation report-download-bin --selector <report-id> --type bin --destination /controlled/artifacts/new-archive.bin --sso')
})

test('with no transfers the saving guidance says none were recorded', async () => {
  grant('beyondtrust-axi')
  const { all, section } = await account()
  expect(section('BeyondTrust endpoint content saving')).toBeDefined()
  expect(all.map(words)).toContain('No archive transfers recorded.')
})
