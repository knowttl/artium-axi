import { expect, test } from 'vitest'
import { kubernetesHosted } from './kubernetes.js'

const session = '8e0724a4-4c35-480e-8231-d37f13cc6fba'
const unconfigured = () => { throw new Error('Configuration must remain unread') }

test.each(['tunnel', 'credential'])('%s help works before client configuration', async command => {
  const output: string[] = []
  await kubernetesHosted([command, '--help', '--json'], unconfigured, text => output.push(text))
  expect(JSON.parse(output.join('')).usage).toContain(`artium-axi kubernetes-axi ${command}`)
})

test.each([
  ['tunnel', session, '--port', '0'],
  ['tunnel', session, '--port', '65536'],
  ['tunnel', session, '--port', '8080', '--port', '8080'],
  ['tunnel', session],
  ['tunnel', 'invalid', '--port', '8080'],
  ['credential', session, '--credential-fd', '1'],
  ['credential', session, '--credential-fd', '4'],
  ['credential', session, '--credential-fd', '9007199254740992'],
  ['credential', session, '--credential-fd', '5', '--output', 'token'],
].map(args => ({ args })))('rejects invalid private transport controls before authentication: $args', async ({ args }) => {
  await expect(kubernetesHosted(args, unconfigured, () => {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
