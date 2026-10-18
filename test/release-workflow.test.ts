import { readFileSync } from 'node:fs'
import { Evaluator, Lexer, Parser, data } from '@actions/expressions'
import { parse } from 'yaml'
import { expect, test } from 'vitest'

type Step = { id?: string, uses?: string, with?: Record<string, unknown>, env?: Record<string, string> }
type Job = { needs?: string[], if?: string, permissions?: Record<string, string>, outputs?: Record<string, string>, env?: Record<string, string>, steps: Step[] }
const workflow = parse(readFileSync('.github/workflows/release-please.yml', 'utf8')) as {
  on: Record<string, unknown>, permissions: Record<string, string>, jobs: Record<string, Job>
}
const image = workflow.jobs['publish-image']

function evaluate(expression: string, context: Record<string, unknown>): string {
  function value(input: unknown): data.ExpressionData {
    if (typeof input === 'string') return new data.StringData(input)
    return new data.Dictionary(...Object.entries(input as Record<string, unknown>).map(([key, item]) => ({ key, value: value(item) })))
  }
  const tokens = new Lexer(expression.slice(3, -2).trim()).lex().tokens
  const tree = new Parser(tokens, Object.keys(context), []).parse()
  return new Evaluator(tree, value(context) as data.Dictionary).evaluate().coerceString()
}

test('publication is reachable only from a main push that creates a release', () => {
  expect(workflow.on).toEqual({ push: { branches: ['main'] } })
  expect(image.needs).toEqual(['release-please', 'publish'])
})

test.each([
  ['true', 'true'], ['false', 'false'], ['', 'false'],
])('release_created=%s gates both publishers to %s', (created, expected) => {
  const context = { needs: { 'release-please': { outputs: { release_created: created } } } }
  expect(evaluate(image.if!, context)).toBe(expected)
  expect(evaluate(workflow.jobs.publish.if!, context)).toBe(expected)
})

test('the release tag supplies both checkouts and the image version, with an immutable digest attestation', () => {
  const context = {
    needs: { 'release-please': { outputs: { tag_name: 'v1.2.3', version: '1.2.3' } } },
    steps: { image: { outputs: { digest: `sha256:${'a'.repeat(64)}` } }, revision: { outputs: { sha: 'release-commit' } } },
    env: image.env!,
  }
  for (const job of [workflow.jobs.publish, image]) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))!
    expect(evaluate(checkout.with!.ref as string, context)).toBe('v1.2.3')
  }
  const build = image.steps.find(step => step.id === 'image')!
  expect(build.with).toMatchObject({ context: '.', file: './Dockerfile', platforms: 'linux/amd64', push: true, provenance: 'mode=max' })
  const tag = (build.with!.tags as string).replace(/\$\{\{.*?\}\}/g, expression => evaluate(expression, context))
  expect(tag).toBe('ghcr.io/knowttl/artium-axi:v1.2.3')
  const labels = Object.fromEntries((build.with!.labels as string).trim().split('\n').map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1).replace(/\$\{\{.*?\}\}/g, expression => evaluate(expression, context))]
  }))
  expect(labels).toEqual({
    'org.opencontainers.image.version': '1.2.3',
    'org.opencontainers.image.source': 'https://github.com/knowttl/artium-axi',
    'org.opencontainers.image.revision': 'release-commit',
  })
  const attestation = image.steps.find(step => step.uses?.startsWith('actions/attest-build-provenance@'))!
  expect(evaluate(attestation.with!['subject-name'] as string, context)).toBe('ghcr.io/knowttl/artium-axi')
  expect(evaluate(attestation.with!['subject-digest'] as string, context)).toBe(`sha256:${'a'.repeat(64)}`)
  expect(attestation.with!['push-to-registry']).toBe(true)
  expect(evaluate(image.outputs!.digest, context)).toBe(`sha256:${'a'.repeat(64)}`)
  const summary = image.steps.find(step => step.env?.DIGEST)!
  expect(evaluate(summary.env!.DIGEST, context)).toBe(`sha256:${'a'.repeat(64)}`)
})

test('registry and attestation writes are scoped to the image job using the Actions token', () => {
  expect(workflow.permissions.packages).toBeUndefined()
  expect(workflow.permissions.attestations).toBeUndefined()
  expect(image.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write' })
  const login = image.steps.find(step => step.uses?.startsWith('docker/login-action@'))!
  expect(login.with).toEqual({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' })
})
