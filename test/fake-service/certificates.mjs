import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

export function createInspectionCertificates(directory, issuerUrl) {
  createTestCertificates(directory, ['localhost', 'login.synthetic.test', 'graph.synthetic.test', 'graph.microsoft.com', 'login.microsoftonline.com'])
  const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe', timeout: 10_000 })
  writeFileSync(join(directory, 'inspection.cnf'), readFileSync(join(directory, 'authority.cnf'), 'utf8') + `
[inspection-server]
subjectAltName = DNS:localhost
basicConstraints = CA:FALSE
extendedKeyUsage = serverAuth
authorityInfoAccess = caIssuers;URI:${issuerUrl}
[mismatch-server]
subjectAltName = DNS:other.synthetic.test
basicConstraints = CA:FALSE
extendedKeyUsage = serverAuth
[non-http-server]
subjectAltName = DNS:localhost
basicConstraints = CA:FALSE
extendedKeyUsage = serverAuth
authorityInfoAccess = caIssuers;URI:ftp://issuer.synthetic.test/intermediate
`)
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Artium synthetic intermediate',
    '-keyout', 'intermediate.key', '-out', 'intermediate.csr'])
  const ca = ['ca', '-batch', '-notext', '-rand_serial', '-config', 'inspection.cnf']
  const validity = ['-startdate', '20200101000000Z', '-enddate', '20991231235959Z']
  openssl([...ca, '-extensions', 'root', '-in', 'intermediate.csr', '-out', 'intermediate.crt', ...validity])
  openssl([...ca, '-extensions', 'inspection-server', '-cert', 'intermediate.crt', '-keyfile', 'intermediate.key',
    '-subj', '/CN=synthetic-leaf', '-in', 'server.csr', '-out', 'leaf.crt', ...validity])
  openssl([...ca, '-extensions', 'inspection-server', '-subj', '/CN=root-issued.synthetic.test',
    '-in', 'server.csr', '-out', 'root-issued.crt', ...validity])
  openssl([...ca, '-extensions', 'inspection-server', '-cert', 'intermediate.crt', '-keyfile', 'intermediate.key',
    '-subj', '/CN=rotated-aia.synthetic.test', '-in', 'server.csr', '-out', 'rotated-aia.crt', ...validity])
  openssl([...ca, '-extensions', 'server', '-cert', 'intermediate.crt', '-keyfile', 'intermediate.key',
    '-subj', '/CN=rotated.synthetic.test', '-in', 'server.csr', '-out', 'rotated.crt', ...validity])
  openssl([...ca, '-extensions', 'server', '-subj', '/CN=expired.synthetic.test', '-in', 'server.csr',
    '-out', 'expired.crt', '-startdate', '20200101000000Z', '-enddate', '20210101000000Z'])
  openssl([...ca, '-extensions', 'mismatch-server', '-subj', '/CN=other.synthetic.test', '-in', 'server.csr',
    '-out', 'mismatch.crt', ...validity])
  openssl([...ca, '-extensions', 'non-http-server', '-cert', 'intermediate.crt', '-keyfile', 'intermediate.key',
    '-subj', '/CN=non-http.synthetic.test', '-in', 'server.csr', '-out', 'non-http.crt', ...validity])
  openssl(['req', '-x509', '-key', 'server.key', '-subj', '/CN=localhost', '-days', '3650',
    '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=CA:FALSE', '-out', 'self-signed.crt'])
}
