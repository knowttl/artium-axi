import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createTestCertificates(directory, hosts) {
  const openssl = args => execFileSync('openssl', args, { stdio: 'pipe', timeout: 10_000 })
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Artium synthetic test CA',
    '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt')])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hosts[0]}`,
    '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')])
  writeFileSync(join(directory, 'extensions'), `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`)
  openssl(['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.crt'),
    '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'server.crt')])
}
