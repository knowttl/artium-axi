import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Evaluator, Lexer, Parser, data } from '@actions/expressions'
import { parse } from 'yaml'
import { expect, test } from 'vitest'

type Step = { id?: string, uses?: string, run?: string, if?: string, 'continue-on-error'?: boolean | string, with?: Record<string, unknown>, env?: Record<string, string> }
type Job = { needs?: string[], if?: string, 'continue-on-error'?: boolean | string, permissions?: Record<string, string>, outputs?: Record<string, string>, env?: Record<string, string>, steps: Step[] }
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

test('publication is reachable only from a main push that creates a release or a dispatched existing tag', () => {
  expect(workflow.on).toEqual({
    push: { branches: ['main'] },
    workflow_dispatch: { inputs: { tag: { description: expect.any(String), required: true, type: 'string' } } },
  })
  expect(image.needs).toEqual(['release-please', 'publish'])
})

test.each([
  ['push outputs', { release: { release_created: 'true', tag_name: 'v1.2.3', version: '1.2.3' }, existing: {} }],
  ['dispatch outputs', { release: {}, existing: { release_created: 'true', tag_name: 'v1.2.3', version: '1.2.3' } }],
])('release outputs resolve from %s', (_name, steps) => {
  const outputs = workflow.jobs['release-please'].outputs!
  const context = Object.fromEntries(Object.entries(steps).map(([id, values]) => [id, { outputs: values }]))
  for (const [key, expected] of [['release_created', 'true'], ['tag_name', 'v1.2.3'], ['version', '1.2.3']]) {
    expect(evaluate(outputs[key], { steps: context })).toBe(expected)
  }
})

test.each([['push', 'true', 'false'], ['workflow_dispatch', 'false', 'true']])('release steps select the %s event', (event, release, existing) => {
  const steps = workflow.jobs['release-please'].steps
  const context = { github: { event_name: event } }
  expect(evaluate(steps.find(step => step.id === 'release')!.if!, context)).toBe(release)
  expect(evaluate(steps.find(step => step.id === 'existing')!.if!, context)).toBe(existing)
})

test('container checks for a dispatched tag run the fixed scripts from main', () => {
  const steps = workflow.jobs.containers.steps
  const overlay = steps[1]
  expect(evaluate(overlay.if!, { github: { event_name: 'push' } })).toBe('false')
  expect(evaluate(overlay.if!, { github: { event_name: 'workflow_dispatch' } })).toBe('true')
  const directory = mkdtempSync(join(process.cwd(), '.tmp-release-'))
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    git('init')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'test', 'runner'), { recursive: true })
    const checks = ['container-checks.mjs', 'build-fake-service-image.mjs', 'mg-headless-check.mjs', 'runner-container-check.mjs', 'host-limits.mjs']
    for (const check of checks) writeFileSync(join(directory, 'scripts', check), 'tag check')
    writeFileSync(join(directory, 'scripts', 'build-cli.mjs'), 'tag build')
    writeFileSync(join(directory, 'test', 'runner', 'probe.mjs'), 'tag probe')
    writeFileSync(join(directory, 'release'), 'tag release')
    git('add', '.')
    git('commit', '-m', 'tag')
    const tag = git('rev-parse', 'HEAD')
    for (const check of checks) writeFileSync(join(directory, 'scripts', check), 'main check')
    writeFileSync(join(directory, 'scripts', 'build-cli.mjs'), 'main build')
    writeFileSync(join(directory, 'test', 'runner', 'probe.mjs'), 'main probe')
    writeFileSync(join(directory, 'release'), 'main release')
    git('commit', '-am', 'main')
    const main = git('rev-parse', 'HEAD')
    git('remote', 'add', 'origin', directory)
    git('checkout', '--detach', tag)
    const result = spawnSync('bash', ['-e', '-c', overlay.run!], { cwd: directory, env: { ...process.env, GITHUB_SHA: main }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    for (const check of checks) expect(readFileSync(join(directory, 'scripts', check), 'utf8')).toBe('main check')
    expect(readFileSync(join(directory, 'scripts', 'build-cli.mjs'), 'utf8')).toBe('tag build')
    expect(readFileSync(join(directory, 'test', 'runner', 'probe.mjs'), 'utf8')).toBe('main probe')
    expect(readFileSync(join(directory, 'release'), 'utf8')).toBe('tag release')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('npm publication waits for container acceptance of the release tag', () => {
  const containers = workflow.jobs.containers
  const acceptance = containers.steps.find(step => step.id === 'acceptance')!
  expect(workflow.jobs.publish.needs).toContain('containers')
  expect(containers['continue-on-error'] ?? false).toBe(false)
  expect(acceptance['continue-on-error'] ?? false).toBe(false)
  expect(acceptance.if).toBeUndefined()
  expect(evaluate(containers.steps[0].with!.ref as string, { needs: { 'release-please': { outputs: { tag_name: 'v1.2.3' } } } })).toBe('v1.2.3')
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
