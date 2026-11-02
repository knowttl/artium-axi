import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createKubernetesAdapter, kubernetesProfile } from './kubernetes.js'
import { toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'

const native = join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js')
const credential = { origin: 'https://cluster.example', auth: 'token', certificateAuthority: 'CANARY-CA-PEM', token: 'CANARY-kubernetes-token' }
const reference = { id: 'synthetic', tool: 'kubernetes-axi', revision: 1 } as const
const adapter = await createKubernetesAdapter({ getCredential: async () => credential }, native)

test.each([
  ['get', 'pods', '-n', 'synthetic', '--selector=app=synthetic'],
  ['get', 'secrets'], ['get', 'deployments', '--continue=opaque'],
  ['describe', 'deployment', 'synthetic'],
  ['native', '--', 'describe', 'deployments,configmaps'],
  ['native', '--', 'get', 'deploy', '-o', 'json'],
  ['native', '--', 'get', '--raw=/version'],
  ['native', '--', 'apply', 'view-last-applied', 'deployment/synthetic'],
  ['rollout', 'status', 'deployment/synthetic', '--watch=false'],
  ['auth', 'can-i', 'get', 'pods'], ['auth', 'whoami'],
])('Kubernetes read arguments reach the pinned grammar unchanged: %j', async (...args) => {
  const call = await adapter.prepare(args, reference)
  expect(call.args).toEqual([native, ...args])
  expect(call.effect).toBe('read')
  expect(call.environment.KUBERNETES_AXI_READ_ONLY).toBe('true')
})

test.each([
  ['prepare', '--', 'delete', 'pod', 'synthetic'], ['preview', 'synthetic'], ['confirm', 'synthetic'],
  ['native', '--', 'delete', 'pod', 'synthetic'], ['native', '--', 'get', 'secrets'],
  ['native', '--', 'apply', 'view-last-applied', 'secret/synthetic'],
  ['describe', 'secret', 'synthetic-token'],
  ['describe', 'secrets.v1', 'synthetic-token'],
  ['describe', 'configmaps,secrets', '--all-namespaces'],
  ['native', '--', 'describe', 'configmap/synthetic', 'secret/synthetic-token'],
  ['native', '--', 'get', 'configmaps,secrets', '--help'],
  ['native', '--', 'apply', 'view-last-applied', 'secrets,configmaps', '--all'],
  ['native', '--', 'apply', 'view-last-applied', 'configmap/synthetic', 'secrets.v1/synthetic-token'],
  ['native', '--', 'get', '--raw=/api/v1/namespaces/default/secrets'],
  ['native', '--', 'get', '--raw=/api/v1/namespaces/default/pods/synthetic/exec'],
  ['native', '--', 'get', 'pods', '-s', 'https://other.example', '--help'],
  ['get', 'pods', '--token=CANARY-forbidden'], ['get', 'pods', '--profile=other'],
  ['get', 'pods', '--insecure-skip-tls-verify', '--help'],
  ['get', 'pods', '-f', '/tmp/input'], ['get', 'pods', '--watch'],
  ['logs', 'synthetic', '--follow'], ['rollout', 'status', 'deployment/synthetic'],
  ['native', '--', 'get', 'pods', '--', '--token=CANARY-forbidden'],
])('Kubernetes refuses operations outside the read boundary before credentials: %j', async (...args) => {
  const guarded = await createKubernetesAdapter({ getCredential: async () => { throw new Error('Credential acquisition must not happen') } }, native)
  await expect(guarded.prepare(args, reference)).rejects.toBeInstanceOf(ArtiumError)
})

test('Kubernetes uses a private SecretRef and owned CA projection', async () => {
  const call = await adapter.prepare(['get', 'pods'], reference)
  expect(call.args.join(' ')).not.toContain(credential.token)
  const profile = JSON.parse(String(call.files[0].content)).profiles.artium
  expect(profile.token).toEqual({ env: 'ARTIUM_SECRET_0' })
  expect(call.environment.ARTIUM_SECRET_0).toBe(credential.token)
  expect(call.files[0].appendTrustedCaAt).toEqual(['profiles', 'artium', 'certificateAuthority'])
  expect(call.limits.systemCaBundle).toEqual({ endpoint: credential.origin })
  expect(toolAllowsWrites('kubernetes-axi', { allowWrites: true })).toBe(false)
})

test.each([
  { origin: 'http://cluster.example' }, { origin: 'https://cluster.example/path' },
  { token: { env: 'AMBIENT_TOKEN' } }, { writes: { allowWrites: true } },
  { auth: 'certificate', token: undefined, clientCertificate: 'CANARY-client-cert' },
])('Kubernetes rejects unsafe or incomplete managed identity: %j', change => {
  expect(kubernetesProfile.credentialSchema.safeParse({ ...credential, ...change }).success).toBe(false)
})

test('Kubernetes certificate identity stores its private key as a SecretRef', async () => {
  const certificate = { origin: credential.origin, auth: 'certificate', certificateAuthority: credential.certificateAuthority,
    clientCertificate: 'CANARY-client-cert', privateKey: 'CANARY-client-key' }
  const client = await createKubernetesAdapter({ getCredential: async () => certificate }, native)
  const call = await client.prepare(['get', 'pods'], reference)
  expect(JSON.parse(String(call.files[0].content)).profiles.artium.privateKey).toEqual({ env: 'ARTIUM_SECRET_0' })
  expect(call.environment.ARTIUM_SECRET_0).toBe(certificate.privateKey)
})

test('Kubernetes native resource data with help-shaped fields is preserved byte for byte', () => {
  const output = JSON.stringify({ apiVersion: 'example.test/v1', kind: 'Task', metadata: { name: 'synthetic' },
    command: 'get', flags: ['server'], help: ['Keep this resource field exactly.'] }) + '\n'
  expect(rewriteSuggestions(output, 'kubernetes-axi', false, { command: 'native --', help: false })).toBe(output)
})
