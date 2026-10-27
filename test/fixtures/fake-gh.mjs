#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === 'issue' && args[1] === 'list') console.log('[]')
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
