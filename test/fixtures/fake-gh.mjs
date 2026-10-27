#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.ARTIUM_TEST_GH_LOG) appendFileSync(process.env.ARTIUM_TEST_GH_LOG, JSON.stringify(args) + '\n')
if (process.env.ARTIUM_TEST_GH_WRITES === '1') {
  const state = process.env.ARTIUM_TEST_GH_WORKFLOW_STATE ?? 'active'
  const workflows = [...Array.from({ length: 50 }, (_, index) => ({ id: index + 1,
    name: index === 0 ? 'CI: tests' : `synthetic-${index + 1}`, state: index === 0 ? state : 'active' })),
  { id: 123, name: 'synthetic-late', state: 'disabled_manually' }]
  if (args[0] === 'workflow' && args[2] === 'CI: tests'
    && (args[1] === 'enable' && state === 'active' || args[1] === 'disable' && state === 'disabled_manually')) {
    console.error('could not find any workflows named CI: tests')
    process.exit(1)
  }
  if (process.env.ARTIUM_TEST_GH_FAILURE === 'mutation-response-lost' && args[0] === 'issue' && args[1] === 'comment') {
    console.error('POST /repos/canary/repo/issues/42/comments: unexpected EOF')
    process.exit(1)
  }
  if (process.env.ARTIUM_TEST_GH_FAILURE === 'mutation-response-lost' && args[0] === 'pr' && args[1] === 'revert') {
    console.error('GraphQL: unexpected EOF while reverting pull request')
    process.exit(1)
  }
  if (process.env.ARTIUM_TEST_GH_FAILURE === 'followup-read-failed' && args[0] === 'issue' && args[1] === 'view') {
    console.error('gh: Bad credentials (HTTP 401)')
    process.exit(1)
  }
  if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--no-type')) {
    console.error('unknown flag: --no-type')
    process.exit(1)
  }
  if (args[0] === 'workflow' && args[1] === 'list') {
    const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 50
    console.log(JSON.stringify(workflows.slice(0, limit)))
  }
  else if (args[0] === 'api' && /^\/repos\/canary\/repo\/actions\/workflows(?:\/123|\?per_page=100)$/.test(args[1])) {
    console.log(JSON.stringify(args[1].endsWith('/123') ? workflows[50] : { workflows }))
  }
  else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({ data: {
    repository: { discussion: { id: 'synthetic-discussion' }, pullRequest: { state: 'MERGED' } },
    addDiscussionComment: { comment: { id: 'synthetic-comment', url: 'https://github.example/canary/repo/discussions/1#comment' } },
    node: { state: 'MERGED', mergeStateStatus: 'CLEAN' },
  } }))
  else if (args.includes('--json') || args.includes('--format')) console.log(JSON.stringify(
    ['label', 'pr'].includes(args[0]) && args[1] === 'list' || args[0] === 'search' ? []
      : { id: 'synthetic-id', number: 1, title: 'synthetic', state: 'OPEN', isDraft: true, isLocked: false, isPinned: false,
        comments: [{ id: 'unrelated-comment', author: { login: 'other-participant' }, body: 'unrelated later comment',
          url: 'https://github.com/canary/repo/issues/1#issuecomment-999' }],
        reviews: [], body: 'synthetic', url: 'https://github.example/canary/repo/issues/1', files: {} }))
  else if (args[0] === 'issue' && args[1] === 'comment') console.log('https://github.com/canary/repo/issues/1#issuecomment-123')
  else if (args[0] === 'issue' && args[1] === 'transfer') console.log('https://github.com/canary/destination/issues/99')
  else console.log(`https://github.com/canary/repo/${args[0] === 'pr' ? 'pull' : args[0] === 'gist' ? 'gist' : 'issues'}/1`)
  process.exit(0)
}
if (args[0] === 'run' && args[1] === 'view') {
  if (args.includes('--log') || args.includes('--log-failed')) console.log('x'.repeat(args.includes('124') ? 10 : 21000) + JSON.stringify(args))
  else console.log(JSON.stringify({ databaseId: 123, jobs: [
    { databaseId: 456, name: 'failed-job', conclusion: 'failure', steps: [] },
    { databaseId: 789, name: 'successful-job', conclusion: 'success', steps: [] },
  ] }))
}
else if (args[0] === 'search') {
  const query = args.slice(args.indexOf('--') + 1).join('|')
  console.log(JSON.stringify([{ number: 1, title: query, fullName: query, path: query, sha: query }]))
}
else if (args[0] === 'issue' && args[1] === 'list') console.log('[]')
else if (args[0] === 'pr' && args[1] === 'diff') console.log('x'.repeat(21000))
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({ number: 1, title: 'canary PR',
  state: 'OPEN', mergeStateStatus: 'BEHIND', statusCheckRollup: [], body: 'Keep gh-axi pr update-branch in resource content.', comments: [], reviews: [] }))
else if (args[0] === 'release' && args[1] === 'list') console.log(JSON.stringify([{ tagName: 'v1', name: 'canary release', isDraft: false, isPrerelease: false }]))
else if (args[0] === 'api' && args[1] === '/canary-unauthorized') {
  console.error('gh: Bad credentials (HTTP 401)')
  process.exitCode = 1
}
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({ data: { repository: { issues: { totalCount: 0 } } } }))
else if (args[0] === 'api' && args[1] === '/rate_limit' && args[2] === '--method' && args[3] === 'GET') {
  const bundle = readFileSync(process.env.SSL_CERT_FILE, 'utf8')
  console.log(JSON.stringify({ remaining: 4999, host: process.env.GH_HOST,
    tokenPresent: (process.env.GH_TOKEN ?? process.env.GH_ENTERPRISE_TOKEN) === 'CANARY-github-token',
    telemetry: process.env.GH_TELEMETRY, prompts: process.env.GH_PROMPT_DISABLED,
    systemRootsPresent: (bundle.match(/BEGIN CERTIFICATE/g) ?? []).length > 1,
    ambientAbsent: process.env.ARTIUM_TEST_AMBIENT === undefined, args }))
} else {
  console.error('Unexpected fake gh invocation')
  process.exitCode = 2
}
