import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate } from './db.js'

let directory: string
let db: Database.Database

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-raw-api-migration-'))
  const previous = join(directory, 'migrations')
  mkdirSync(previous)
  for (const file of readdirSync('src/server/store/migrations').filter(file => Number(file.split('-')[0]) < 31)) {
    copyFileSync(join('src/server/store/migrations', file), join(previous, file))
  }
  db = new Database(join(directory, 'populated.db'))
  db.pragma('foreign_keys = ON')
  migrate(db, previous)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('upgrade keeps existing raw routes readable for current grants and leaves every other tool off', () => {
  const rawTools = ['gh-axi', 'az-axi', 'ado-axi', 'gitea-axi', 'mg-axi', 'vectra-axi', 'hybrid-axi']
  const otherTools = ['falcon-axi', 'ldap-axi']
  db.exec("INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role')")
  for (const tool of [...rawTools, ...otherTools]) {
    db.prepare("INSERT INTO tools (name, pinned_version) VALUES (?, 'synthetic-version')").run(tool)
    db.prepare('INSERT INTO role_tools (role_id, tool) VALUES (?, ?)').run('synthetic-role', tool)
  }
  migrate(db)
  expect(db.prepare('SELECT name FROM tools WHERE raw_api_mode = ? ORDER BY name').all('read').map(row => (row as { name: string }).name))
    .toEqual([...rawTools].sort())
  expect(db.prepare('SELECT name FROM tools WHERE raw_api_mode = ? ORDER BY name').all('off').map(row => (row as { name: string }).name))
    .toEqual(otherTools)
  expect(db.prepare('SELECT tool FROM role_tools WHERE raw_api = 1 ORDER BY tool').all().map(row => (row as { tool: string }).tool))
    .toEqual([...rawTools].sort())
})
