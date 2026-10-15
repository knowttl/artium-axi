import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createTestCertificates(directory, hosts) {
  const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe', timeout: 10_000 })
  writeFileSync(join(directory, 'index'), '')
  writeFileSync(join(directory, 'authority.cnf'), `[ca]
default_ca = synthetic
[synthetic]
database = index
serial = serial
new_certs_dir = .
private_key = ca.key
certificate = ca.crt
default_md = sha256
policy = subject
[subject]
commonName = supplied
[root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[server]
subjectAltName = ${hosts.map(host => `DNS:${host}`).join(',')}
basicConstraints = CA:FALSE
extendedKeyUsage = serverAuth
`)
  // Fixed dates keep synthetic TLS independent of clock skew between processes.
  const validity = ['-startdate', '20200101000000Z', '-enddate', '20991231235959Z']
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Artium synthetic test CA',
    '-keyout', 'ca.key', '-out', 'ca.csr'])
  openssl(['ca', '-batch', '-notext', '-rand_serial', '-selfsign', '-config', 'authority.cnf',
    '-extensions', 'root', '-in', 'ca.csr', '-out', 'ca.crt', ...validity])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hosts[0]}`,
    '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')])
  openssl(['ca', '-batch', '-notext', '-rand_serial', '-config', 'authority.cnf',
    '-extensions', 'server', '-in', 'server.csr', '-out', 'server.crt', ...validity])
}
