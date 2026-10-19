import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { run } from '../../tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js'

const result = await run(process.argv.slice(2), { openDirectory: async options => {
  assert.equal(options.url, 'ldaps://directory.test:636')
  assert.equal(options.authPlan.mode, 'simple')
  assert.equal(options.authPlan.credentials.dn, 'uid=reader')
  assert.equal(options.authPlan.credentials.password, 'CANARY-ldap-password')
  assert.equal(options.tlsNoVerify, false)
  if (options.caFile) assert.equal(readFileSync(options.caFile, 'utf8'), 'CANARY-ca-pem\nsynthetic-ca-line\n')
  return {
    flavor: 'ldapv3',
    async rootDSE() { return { flavor: 'ldapv3', attributes: { namingContexts: ['ou=people'], supportedExtension: [] } } },
    async *searchPages(request) {
      assert.equal(request.base, 'ou=people')
      yield { entries: request.filter.includes('(objectClass=device)')
        ? [{ dn: 'cn=synthetic-computer,ou=people', attributes: { cn: ['Synthetic Computer'], objectClass: ['device'] } }]
        : [{ dn: 'uid=synthetic,ou=people', attributes: { uid: ['synthetic'], cn: ['Synthetic User'] } }] }
    },
    async close() {},
  }
} })
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.exitCode
