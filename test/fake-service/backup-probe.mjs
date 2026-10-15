import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { openStore, createCredentialStore } from '/opt/artium/dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '/opt/artium/dist/src/server/store/key-provider.js'
import { issueLoginTokens, logout, verifyAccessToken } from '/opt/artium/dist/src/server/auth/tokens.js'
import { Audit } from '/opt/artium/dist/src/server/audit/audit.js'

assert.equal(process.getuid(), 10001)
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
const maintenance = (command, flag, path, file) => {
  const result = spawnSync('artium-axi-server', [command, flag, path], { encoding: 'utf8',
    env: { ...process.env, ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY: provider.getKey().bytes.toString('base64') } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /status: completed/)
}
if (process.argv[2] === 'backup') {
  const db = openStore('/tmp/source/artium.db', provider)
  try {
    db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change, administrator)
      VALUES ('synthetic-admin', 'synthetic-admin', 'Synthetic Admin', 'synthetic-hash', 0, 1);
      INSERT INTO bootstrap_metadata VALUES (1, 1);
      INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-admin', 'synthetic-role');
      INSERT INTO role_tools VALUES ('synthetic-role', 'falcon-axi');
      INSERT INTO audit (occurred_at, event, outcome) VALUES (1, 'synthetic-backup-proof', 'success');`)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('falcon-axi', { secret: 'CANARY-container-backup' }, 0, 'synthetic-admin', 1)
    const pair = issueLoginTokens(db, 'synthetic-admin')
    assert.equal(pair.status, 'authenticated')
    maintenance('backup', '--out', '/data/pre-upgrade.db', '/tmp/source/artium.db')
    logout(db, pair.accessToken, new Audit(db, Date.now, () => {}), { requestId: 'synthetic-revoke', clientAddress: '127.0.0.1' })
    writeFileSync('/data/synthetic-proof.json', JSON.stringify({ accessToken: pair.accessToken }), { mode: 0o600 })
    assert.equal(statSync('/data/pre-upgrade.db').mode & 0o777, 0o600)
  } finally { db.close() }
  console.log('backup-container: non-root online SQLite backup completed; token revoked after backup')
} else {
  maintenance('restore', '--from', '/backups/pre-upgrade.db', '/data/artium.db')
  const db = openStore('/data/artium.db', provider)
  try {
    const proof = JSON.parse(readFileSync('/backups/synthetic-proof.json', 'utf8'))
    assert.throws(() => verifyAccessToken(db, proof.accessToken), { code: 'TOKEN_INVALID' })
    const store = createCredentialStore(db, provider)
    assert.deepEqual(store.readCredential(store.findCredential('falcon-axi')), { secret: 'CANARY-container-backup' })
    assert.deepEqual(db.prepare('SELECT * FROM role_tools').all(), [{ role_id: 'synthetic-role', tool: 'falcon-axi' }])
    assert.deepEqual(db.prepare('SELECT event FROM audit').all(), [{ event: 'synthetic-backup-proof' }])
    const pair = issueLoginTokens(db, 'synthetic-admin')
    assert.equal(pair.status, 'authenticated')
    assert.equal(verifyAccessToken(db, pair.accessToken), 'synthetic-admin')
    assert.equal(statSync('/data/artium.db').mode & 0o777, 0o600)
  } finally { db.close() }
  console.log('restore-container: new non-root container and volume; credentials, roles, audit and fresh login pass; old token refused')
}
