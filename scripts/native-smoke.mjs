import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { hash, verify, argon2id } from 'argon2'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'artium-native-'))
try {
  const file = join(directory, 'smoke.db')
  const db = new Database(file)
  db.exec('CREATE TABLE smoke (value TEXT)')
  db.prepare('INSERT INTO smoke VALUES (?)').run('synthetic')
  db.close()
  const reopened = new Database(file)
  try {
    assert.deepEqual(reopened.prepare('SELECT value FROM smoke').get(), { value: 'synthetic' })
  } finally {
    reopened.close()
  }
  const encoded = await hash('CANARY-native-password', { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 })
  assert.equal(await verify(encoded, 'CANARY-native-password'), true)
  assert.equal(await verify(encoded, 'CANARY-wrong-password'), false)
  const bundle = join(directory, 'smoke.mjs')
  await build({ stdin: { contents: 'const value: string = "synthetic"; console.log(value)', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle })
  assert.equal(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }).trim(), 'synthetic')
  console.log('SQLite reopen, Argon2 hash/verify and esbuild bundle execution passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
