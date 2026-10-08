import { openStore } from '/opt/artium/dist/src/server/store/db.js'
import { encryptCredential } from '/opt/artium/dist/src/server/store/crypto.js'
import { EnvironmentKeyProvider } from '/opt/artium/dist/src/server/store/key-provider.js'
import { readFileSync, writeFileSync } from 'node:fs'

const provider = new EnvironmentKeyProvider()
const db = openStore('/data/artium.db', provider)
writeFileSync('/data/token', process.env.ARTIUM_TEST_TOKEN, { mode: 0o600 })
try {
  db.prepare("UPDATE tools SET enabled = 1, pinned_version = '0.3.0' WHERE name = 'falcon-axi'").run()
  const credential = encryptCredential('synthetic-falcon', 'falcon-axi', Buffer.from(JSON.stringify({
    clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-1',
  })), provider.getKey())
  db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)`).run(credential)
  db.prepare("UPDATE tools SET enabled = 1, pinned_version = '0.1.3' WHERE name = 'vectra-axi'").run()
  const vectra = encryptCredential('synthetic-vectra', 'vectra-axi', Buffer.from(JSON.stringify({
    kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test', auth: 'token', token: 'CANARY-vectra-token',
    caBundle: readFileSync('/certs/ca.crt', 'utf8'), writes: { allowWrites: true, operations: ['qux.detection.tag.set'] },
  })), provider.getKey())
  db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)`).run(vectra)
} finally { db.close() }
