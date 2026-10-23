import { dirname, join, resolve } from 'node:path'
import { createApp } from './app.js'
import { createFalconAdapter } from './adapters/falcon.js'
import { createVectraAdapter } from './adapters/vectra.js'
import { createAzAdapter } from './adapters/az.js'
import { createMgAdapter } from './adapters/mg.js'
import { createLdapAdapter } from './adapters/ldap.js'
import { createAdoAdapter } from './adapters/ado.js'
import { createAwxAdapter } from './adapters/awx.js'
import { createTenableAdapter } from './adapters/tenable.js'
import { createHybridAdapter } from './adapters/hybrid.js'
import { AzureTokenCache } from './adapters/azure-token-cache.js'
import { initializeNativeWriteLog, retainNativeWriteLog } from './adapters/native-log.js'
import { retainRunJournals } from './adapters/run-journal.js'
import { Audit } from './audit/audit.js'
import { checkAuthSettings } from './auth/settings.js'
import { bootstrapAdministrator } from './auth/bootstrap.js'
import { serverDefaults } from './config.js'
import { SharedIdentityResolver } from './policy/identity-resolver.js'
import { Runner } from './runner/runner.js'
import { createCredentialStore, openStore } from './store/db.js'
import { ProviderCredentials } from './store/provider-credentials.js'
import { EmbeddedSecretSource } from './store/secret-source.js'
import { EnvironmentKeyProvider, saveMasterKey } from './store/key-provider.js'
import { acquireMaintenanceLock } from './store/maintenance-lock.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'
import { installTrustedCa, loadTrustedCa } from './trusted-ca.js'

async function main() {
  checkAuthSettings(process.env)
  const trustedCa = loadTrustedCa()
  installTrustedCa(trustedCa)
  const database = resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database)
  const release = acquireMaintenanceLock(database)
  let db: ReturnType<typeof openStore> | undefined
  let runner: Runner | undefined
  try {
    const key = new EnvironmentKeyProvider().getKey()
    const provider = { getKey: () => key }
    db = openStore(database, provider)
    saveMasterKey(database, key)
    await bootstrapAdministrator(db)
    const connection = db
    const store = createCredentialStore(db, provider)
    runner = await Runner.create(serverDefaults.temporaryDirectory, trustedCa)
    const audit = new Audit(db)
    const source = new EmbeddedSecretSource(store)
    const azureTokens = new AzureTokenCache()
    const writeLog = join(dirname(database), 'tool-logs', 'vectra-axi', 'writes.log')
    try { initializeNativeWriteLog(writeLog) }
    catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
    const app = createApp({ db, audit, runner, credentialStore: store, providerCredentials: new ProviderCredentials(db, provider), resolver: new SharedIdentityResolver(store),
      adapters: [createFalconAdapter(source, join(dirname(database), 'tool-logs', 'falcon-axi', 'writes.log')),
        createVectraAdapter(source, writeLog),
        createAzAdapter(source, join(dirname(database), 'tool-logs', 'az-axi', 'writes.log'), azureTokens),
        createMgAdapter(source, join(dirname(database), 'tool-logs', 'mg-axi', 'writes.log')),
        createLdapAdapter(source), createAdoAdapter(source, azureTokens),
        createAwxAdapter(source), createTenableAdapter(source, join(dirname(database), 'tool-logs', 'tenable-axi', 'writes.log')),
        createHybridAdapter(source, join(dirname(database), 'tool-logs', 'hybrid-axi', 'writes.log'))] })
    const maintain = async () => {
      try { audit.maintain() }
      catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
      try { retainNativeWriteLog(writeLog) }
      catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
      for (const tool of ['az-axi', 'mg-axi', 'vectra-axi'] as const) {
        try { await retainRunJournals(join(dirname(database), 'tool-logs', tool, 'writes.log'), tool) }
        catch { process.stderr.write(`${JSON.stringify(errorResponse(new ArtiumError('AUDIT_UNAVAILABLE'), 'retention'))}\n`) }
      }
    }
    await maintain()
    const retention = setInterval(() => { void maintain() }, 24 * 60 * 60 * 1000)
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
