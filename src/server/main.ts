import { dirname, join, resolve } from 'node:path'
import { createApp } from './app.js'
import { createFalconAdapter } from './adapters/falcon.js'
import { createVectraAdapter } from './adapters/vectra.js'
import { initializeNativeWriteLog, retainNativeWriteLog } from './adapters/native-log.js'
import { Audit } from './audit/audit.js'
import { readDevelopmentToken } from './auth/development.js'
import { serverDefaults } from './config.js'
import { SharedIdentityResolver } from './policy/identity-resolver.js'
import { Runner } from './runner/runner.js'
import { createCredentialStore, openStore } from './store/db.js'
import { EmbeddedSecretSource } from './store/secret-source.js'
import { EnvironmentKeyProvider } from './store/key-provider.js'
import { acquireMaintenanceLock } from './store/maintenance-lock.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'

async function main() {
  readDevelopmentToken(process.env)
  const database = resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database)
  const release = acquireMaintenanceLock(database)
  let db: ReturnType<typeof openStore> | undefined
  let runner: Runner | undefined
  try {
    db = openStore(database)
    const connection = db
    const store = createCredentialStore(db, new EnvironmentKeyProvider())
    runner = await Runner.create(serverDefaults.temporaryDirectory)
    const audit = new Audit(db)
    const source = new EmbeddedSecretSource(store)
    const writeLog = join(dirname(database), 'tool-logs', 'vectra-axi', 'writes.log')
    try { initializeNativeWriteLog(writeLog) }
    catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
    const app = createApp({ db, audit, runner, resolver: new SharedIdentityResolver(store),
      adapters: [createFalconAdapter(source), createVectraAdapter(source, writeLog)] })
    const maintain = () => {
      try { audit.maintain(); retainNativeWriteLog(writeLog) }
      catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
    }
    maintain()
    const retention = setInterval(maintain, 24 * 60 * 60 * 1000)
    retention.unref()
    app.addHook('onClose', async () => { clearInterval(retention); connection.close(); release() })
    await app.listen({ host: serverDefaults.host, port: serverDefaults.port })
    const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  } catch (error) {
    await runner?.shutdown()
    if (db?.open) db.close()
    release()
    throw error
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorResponse(error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR'), 'startup'))}\n`)
  process.exitCode = 1
})
