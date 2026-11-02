import { expect, test } from 'vitest'
import { giteaProfile } from './gitea.js'

test.each([
  { origin: 'http://forge.example', tokenOrigin: 'http://forge.example' },
  { origin: 'https://forge.example/path', tokenOrigin: 'https://forge.example/path' },
  { origin: 'https://forge.example', tokenOrigin: 'https://other.example' },
  { origin: 'https://forge.example', tokenOrigin: 'https://forge.example', writes: { allowWrites: true, operations: ['issue.create'] } },
])('Gitea credential input refuses unsafe binding or policy: %j', identity => {
  expect(giteaProfile.credentialSchema.safeParse({ ...identity, token: 'CANARY-gitea-token' }).success).toBe(false)
})
