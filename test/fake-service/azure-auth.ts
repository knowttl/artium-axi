import { readFileSync } from 'node:fs'
import { mintAzureToken } from '../../src/server/adapters/azure-tokens.js'
import { SecretScanner } from '../../src/server/runner/scan.js'
import { FakeTokenTransport } from '../fixtures/azure-token-transport.js'

async function main() {
  const [secret, certificate] = JSON.parse(readFileSync(0, 'utf8'))
  const secretNetwork = new FakeTokenTransport()
  const certificateNetwork = new FakeTokenTransport()
  const secretToken = await mintAzureToken(secret, 'arm', secretNetwork)
  const certificateToken = await mintAzureToken(certificate, 'arm', certificateNetwork)
  const assertion = certificateNetwork.requests[0].form.get('client_assertion')!
  console.log(JSON.stringify({ requests: secretNetwork.requests.length + certificateNetwork.requests.length,
    secretScanned: new SecretScanner(secretToken.secrets).scan('stdout', Buffer.from(secret.clientSecret)),
    assertionScanned: new SecretScanner(certificateToken.secrets).scan('stdout', Buffer.from(assertion)) }))
}

void main()
