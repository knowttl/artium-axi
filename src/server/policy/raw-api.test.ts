import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Adapter } from '../adapters/types.js'
import { createAdoAdapter } from '../adapters/ado.js'
import { createAwxAdapter } from '../adapters/awx.js'
import { createAzAdapter } from '../adapters/az.js'
import { createFalconAdapter } from '../adapters/falcon.js'
import { createGhAdapter } from '../adapters/gh.js'
import { createGiteaAdapter } from '../adapters/gitea.js'
import { createHybridAdapter } from '../adapters/hybrid.js'
import { createKubernetesAdapter } from '../adapters/kubernetes.js'
import { createMgAdapter } from '../adapters/mg.js'
import { createTenableAdapter } from '../adapters/tenable.js'
import { createVectraAdapter } from '../adapters/vectra.js'
import type { RunnerInput } from '../runner/input.js'
import { matchRawApiRoute, readRawApiCall, upstreamStatus, validateRawApiRoutes } from './raw-api.js'
import type { RawApiCall } from './raw-api.js'

const source = { getCredential: async () => ({}) }
const log = join(process.cwd(), 'synthetic-raw-api.log')
const adapters: Adapter<unknown>[] = [createAdoAdapter(source), createGhAdapter(source), createGiteaAdapter(source, log),
  createAzAdapter(source, log), createAwxAdapter(source), createMgAdapter(source, log), createVectraAdapter(source, log),
  createHybridAdapter(source, log), createFalconAdapter(source, log), createTenableAdapter(source, log),
  await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))]
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const objectSha = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
const file = (name: string, content: string) => ({ name, contentBase64: Buffer.from(content).toString('base64') })

test.each<[string, string[], RunnerInput, RawApiCall]>([
  ['ado-axi', ['api', 'PATCH', '_apis/wit/workitems/1', '--body', '{"a":1}'], {},
    { method: 'PATCH', path: '_apis/wit/workitems/1', query: [], bodySha256: '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862', bodyBytes: 7 }],
  ['ado-axi', ['api', '-X', 'delete', '_apis/projects/2'], {},
    { method: 'DELETE', path: '_apis/projects/2', query: [], bodySha256: emptySha, bodyBytes: 0 }],
  ['ado-axi', ['--profile', 'synthetic', 'api', '_apis/projects', '--query', '$top=2'], {},
    { method: 'GET', path: '_apis/projects', query: [{ name: '$top', sha256: 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35' }], bodySha256: emptySha, bodyBytes: 0 }],
  ['gh-axi', ['api', '/repos/synthetic/synthetic/issues?per_page=5'], {},
    { method: 'GET', path: 'repos/synthetic/synthetic/issues', query: [{ name: 'per_page', sha256: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d' }], bodySha256: emptySha, bodyBytes: 0 }],
  ['gh-axi', ['api', '-R', 'synthetic/synthetic', '--method', 'post', 'repos/synthetic/synthetic'], {},
    { method: 'POST', path: 'repos/synthetic/synthetic', query: [], bodySha256: emptySha, bodyBytes: 0 }],
  ['gitea-axi', ['api', 'POST', 'repos/synthetic/synthetic/issues', '--field', 'title=x'], {},
    { method: 'POST', path: 'api/v1/repos/synthetic/synthetic/issues', query: [], bodySha256: 'b9782aa572484c19cfb52c4c1f00138d423e08100bd1e7337681d352d40e58a0', bodyBytes: 7 }],
  ['gitea-axi', ['api', '--method', 'PUT', '/api/v1/user/starred/synthetic/synthetic', '--input', '-'], { stdin: '{}' },
    { method: 'PUT', path: 'api/v1/user/starred/synthetic/synthetic', query: [], bodySha256: objectSha, bodyBytes: 2 }],
  ['az-axi', ['api', 'PUT', 'https://management.azure.com/subscriptions/synthetic?api-version=2', '--body', '{}'], {},
    { method: 'PUT', path: 'subscriptions/synthetic', query: [{ name: 'api-version', sha256: 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35' }], bodySha256: objectSha, bodyBytes: 2 }],
  ['az-axi', ['api', 'POST', '/subscriptions/synthetic/tags', '--body-file', 'body.json'], { files: [file('body.json', '{}')] },
    { method: 'POST', path: 'subscriptions/synthetic/tags', query: [], bodySha256: objectSha, bodyBytes: 2 }],
  ['awx-axi', ['api', 'post', 'jobs/1/cancel/', '--body-file', 'body.json', '--confirm'], { files: [file('body.json', '{}')] },
    { method: 'POST', path: 'jobs/1/cancel', query: [], bodySha256: objectSha, bodyBytes: 2 }],
  ['mg-axi', ['api', 'get', '/users', '--query', '$top=2'], {},
    { method: 'GET', path: 'users', query: [{ name: '$top', sha256: 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35' }], bodySha256: emptySha, bodyBytes: 0 }],
  ['vectra-axi', ['api', 'get', '--path', '/detections'], {},
    { method: 'GET', path: 'detections', query: [], bodySha256: emptySha, bodyBytes: 0 }],
  ['hybrid-axi', ['api', 'get', '/report/synthetic'], {},
    { method: 'GET', path: 'report/synthetic', query: [], bodySha256: emptySha, bodyBytes: 0 }],
  ['falcon-axi', ['raw', 'write', '--method', 'post', '--path', '/synthetic/v1', '--body-file', '-'], { stdin: '{}' },
    { method: 'POST', path: 'synthetic/v1', query: [], bodySha256: objectSha, bodyBytes: 2 }],
  ['tenable-axi', ['raw', 'get', '--path', '/api/v1/t1/tags/properties', '--query', 'limit=2'], {},
    { method: 'GET', path: 'api/v1/t1/tags/properties', query: [{ name: 'limit', sha256: 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35' }], bodySha256: emptySha, bodyBytes: 0 }],
  ['kubernetes-axi', ['native', '--', 'get', 'pods', 'synthetic', '-n', 'ns'], {},
    { method: 'GET', path: 'pods/synthetic', query: [{ name: 'namespace', sha256: '7bfba6e0021f1fd1183dfefe60216f13140365788780f2a26fd8fc1f08b2aa2c' }], bodySha256: emptySha, bodyBytes: 0 }],
  ['ado-axi', ['api', 'PATCH', '_apis/%2e%2e/projects', '--body', '{}'], {},
    { method: 'PATCH', path: null, query: [], bodySha256: objectSha, bodyBytes: 2 }],
  ['ado-axi', ['api', 'PATCH', '_apis/wit/a%2Fb', '--body', '{}'], {},
    { method: 'PATCH', path: null, query: [], bodySha256: objectSha, bodyBytes: 2 }],
])('%s raw call %j is described as %j', (tool, args, input, expected) => {
  expect(readRawApiCall(adapters.find(adapter => adapter.name === tool)!, args, input)).toEqual(expected)
})

test.each([
  ['ado-axi', ['api', '--help']],
  ['ado-axi', ['work-item', 'list']],
  ['gh-axi', ['api', 'repos/synthetic/synthetic', '-h']],
  ['falcon-axi', ['raw', 'get', '--path', '/synthetic/v1', '--help']],
  ['kubernetes-axi', ['native', '--', 'get', '--help']],
  ['kubernetes-axi', ['get', 'pods']],
] as const)('%s call %j is not a raw request', (tool, args) => {
  expect(readRawApiCall(adapters.find(adapter => adapter.name === tool)!, args)).toBeUndefined()
})

test.each([
  ['an exact path', ['PATCH _apis/wit/workitems/*'], 'PATCH', '_apis/wit/workitems/1', 'PATCH _apis/wit/workitems/*'],
  ['a deeper path', ['PATCH _apis/wit/workitems/*'], 'PATCH', '_apis/wit/workitems/1/comments', undefined],
  ['another method', ['PATCH _apis/wit/workitems/*'], 'DELETE', '_apis/wit/workitems/1', undefined],
  ['a prefix pattern', ['POST _apis/wit/**'], 'POST', '_apis/wit/workitems/1/comments', 'POST _apis/wit/**'],
  ['the prefix itself', ['POST _apis/wit/**'], 'POST', '_apis/wit', 'POST _apis/wit/**'],
  ['an unrelated prefix', ['POST _apis/wit/**'], 'POST', '_apis/git/repositories', undefined],
  ['a wildcard that must not match an empty segment', ['PUT a/*/c'], 'PUT', 'a/c', undefined],
  ['a canonically encoded segment', ['PUT a/b%20c'], 'PUT', 'a/b%20c', 'PUT a/b%20c'],
  ['a path that could not be normalized', ['PUT **'], 'PUT', null, undefined],
  ['the first matching entry', ['PUT **', 'PUT a/b'], 'PUT', 'a/b', 'PUT **'],
] as const)('write routes %s', (_name, list, method, path, expected) => {
  expect(matchRawApiRoute(list, true, { method, path })).toBe(expected)
})

test.each([
  ['an exact path', ['users/*'], 'users/1', 'users/*'],
  ['a different path', ['users/*'], 'groups/1', undefined],
  ['a prefix', ['users/**'], 'users/1/memberOf', 'users/**'],
] as const)('GET routes match %s', (_name, list, path, expected) => {
  expect(matchRawApiRoute(list, false, { method: 'GET', path })).toBe(expected)
})

test.each([
  ['a write entry without a method', { get: [], write: ['_apis/wit/*'] }],
  ['a write entry with a read method', { get: [], write: ['GET _apis/wit/*'] }],
  ['a write entry with extra words', { get: [], write: ['PATCH _apis/wit/* extra'] }],
  ['a leading slash', { get: ['/users'], write: [] }],
  ['an empty segment', { get: ['users//1'], write: [] }],
  ['a traversal segment', { get: [], write: ['PUT a/../b'] }],
  ['a prefix marker before the end', { get: ['a/**/b'], write: [] }],
])('route validation rejects %s', (_name, routes) => {
  expect(() => validateRawApiRoutes(routes)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test('route validation accepts relative GET paths, write methods and prefix markers', () => {
  expect(() => validateRawApiRoutes({ get: ['_apis/projects/*', 'users/**'], write: ['PATCH _apis/wit/workitems/*', 'DELETE a/b/**'] })).not.toThrow()
})

test.each([
  ['api_response:\n  method: PATCH\n  path: projects/42/\n  status: 200\n  body:\n    status: 500\n', 200],
  ['api_response:\n  status: 404\n', 404],
  ['api_response:\n  body:\n    status: 500\n', null],
  ['jobs[1]:\n  status: 200\n', null],
  ['', null],
] as const)('upstream status of %j is %j', (stdout, expected) => {
  expect(upstreamStatus(stdout)).toBe(expected)
})
