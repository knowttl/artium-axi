import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { ArtifactStore, artifactDefaults } from '/opt/artium/dist/src/server/artifacts.js'
import { Audit } from '/opt/artium/dist/src/server/audit/audit.js'
import { hybridProfile } from '/opt/artium/dist/src/server/adapters/hybrid.js'
import { Runner } from '/opt/artium/dist/src/server/runner/runner.js'
import { executeNativeArtifact, previewNativeArtifact } from '/opt/artium/dist/src/server/runner/artifact.js'
import { openStore } from '/opt/artium/dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '/opt/artium/dist/src/server/store/key-provider.js'
import { createTransferScope } from '/opt/artium/dist/src/server/transfer.js'
import { transferLimits } from '/opt/artium/dist/src/shared/api.js'

assert.equal(process.getuid(), 10001)
const db = openStore('/tmp/store/artium.db', new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
const audit = new Audit(db, Date.now, () => {})
const store = await ArtifactStore.create(audit)
const runner = await Runner.create()
try {
  assert.equal((await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0')
  assert.equal((await readFile('/sys/fs/cgroup/memory.swap.current', 'utf8')).trim(), '0')
  const reservations = []
  for (let index = 0; index < transferLimits.reservations; index++) {
    const userId = `synthetic-${index}`
    db.prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, userId, userId, 'CANARY-hash')
    const scope = createTransferScope({ userId, sessionFamilyId: 'family', reauthenticatedAt: Date.now() }, 1,
      { selection: { operation: 'hash-download-bin', selector: 'a'.repeat(64), type: 'bin' }, targetDigest: 'b'.repeat(64) })
    reservations.push(await store.reserve(scope, { requestId: userId, clientAddress: null }))
  }
  const block = Buffer.alloc(1024 * 1024, 0xa5)
  const hash = createHash('sha256')
  for (let index = 0; index < 250; index++) hash.update(block)
  const digest = hash.digest('hex')
  const before = await readFile('/sys/fs/cgroup/memory.events', 'utf8')
  const measurements = await Promise.all(reservations.map(async reservation => {
    const id = reservation.scope.userId
    const prepare = async args => {
      const profile = hybridProfile.prepare('hybrid-axi', { apiKey: 'CANARY-artifact-key',
        writes: { allowWrites: true, operations: [reservation.scope.selection.operation] } }, `/tmp/store/${id}.log`, false)
      return { executable: process.execPath, args: ['/work/test/fake-tool/fake-axi.mjs', 'native-artifact', ...args], ...profile,
        environment: { ...profile.environment, ARTIUM_TEST_ARTIFACT_BYTES: String(transferLimits.artifactBytes),
          ARTIUM_TEST_RSS_FILE: `/tmp/${id}.rss` }, limits: { timeoutMs: 60_000 } }
    }
    const preview = await previewNativeArtifact(reservation, runner, prepare, () => {})
    assert.equal(JSON.parse(await readFile(`/tmp/${id}.rss`, 'utf8')).requests, 0)
    const archive = await executeNativeArtifact(reservation, runner, prepare, preview.confirm, () => {})
    assert.equal(archive.archiveBytes, transferLimits.artifactBytes)
    assert.equal(archive.archiveSha256, digest)
    const measurement = JSON.parse(await readFile(`/tmp/${id}.rss`, 'utf8'))
    assert.ok(measurement.maxRssBytes < artifactDefaults.childResidentBytes)
    assert.equal(measurement.requests, 1)
    return measurement
  }))
  assert.equal(await readFile('/sys/fs/cgroup/memory.events', 'utf8'), before)
  assert.equal((await readFile('/sys/fs/cgroup/memory.swap.current', 'utf8')).trim(), '0')
  assert.equal((await readdir('/tmp/artium-artifacts')).length, 4)
  const peak = Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8'))
  assert.ok(peak < artifactDefaults.containerBytes)
  console.log(`artifact-container: ${JSON.stringify({ measurements, peak, memoryMax: artifactDefaults.containerBytes,
    tmpfsBytes: transferLimits.reservedBytes, swapMax: 0, swapCurrent: 0, opaqueBytesVerified: true })}`)
} finally {
  await store.shutdown()
  await runner.shutdown()
  db.close()
}
assert.deepEqual(await readdir('/tmp/artium-artifacts'), [])
console.log('artifact-container: consumers stopped and all four maximum-size artifacts removed')
