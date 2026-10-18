import { expect, test } from 'vitest'
import { certificateEndpoint } from './certificate-endpoint.js'

test.each([
  ['LDAPS://Directory.synthetic.test', 'ldaps://directory.synthetic.test:636/'],
  ['ldaps://Directory.synthetic.test:636/', 'ldaps://directory.synthetic.test:636/'],
  ['LDAP://Directory.synthetic.test/', 'ldap://directory.synthetic.test:389/'],
  ['ldap://Directory.synthetic.test:389', 'ldap://directory.synthetic.test:389/'],
  ['HTTPS://Directory.synthetic.test:443/', 'https://directory.synthetic.test/'],
  ['ldaps://Directory.synthetic.test:1636/', 'ldaps://directory.synthetic.test:1636/'],
  ['ldaps://[::1]', 'ldaps://[::1]:636/'],
])('canonicalizes certificate endpoint %s', (value, expected) => {
  expect(certificateEndpoint(value).href).toBe(expected)
  expect(certificateEndpoint(certificateEndpoint(value).href)).toEqual(certificateEndpoint(value))
})
