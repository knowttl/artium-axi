import { join } from 'node:path'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'

const directory = process.argv[2]
const provider = new EnvironmentKeyProvider(process.env)
const db = openStore(join(directory, 'data', 'artium.db'), provider)
const store = createCredentialStore(db, provider)
const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner: await Runner.create(join(directory, 'restart-calls')),
  credentialStore: store, sshHosts: new SshHosts(db, provider), resolver: new SharedIdentityResolver(store, db), adapters: [],
  sshExecution: { provider, writeLog: join(directory, 'writes.log') }, environment: {} })
const url = await app.listen({ host: '127.0.0.1', port: 0 })
process.send?.({ url })
process.once('SIGTERM', () => { void app.close().then(() => { db.close(); process.exit(0) }) })
