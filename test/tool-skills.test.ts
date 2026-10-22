import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadToolSkill } from '../src/server/tool-skills.js'
import { toolSchema } from '../src/shared/api.js'

test.each(toolSchema.options)('%s overlay preserves tool guidance with managed command examples', tool => {
  const source = tool === 'falcon-axi' ? 'test/fixtures/falcon-SKILL.md' : tool === 'awx-axi' ? 'tools/skills/awx-axi/SKILL.md' : tool === 'ado-axi' ? 'tools/node_modules/@jeffreyhaen/ado-axi/SKILL.md' : `tools/node_modules/@knowttl/${tool}/skills/${tool}/SKILL.md`
  const skill = loadToolSkill(tool, source)
  expect(skill).toContain(`name: ${tool}`)
  expect(skill).toContain(`artium-axi ${tool}`)
  expect(skill).toContain('Artium supplies the managed credentials')
  expect(skill).not.toMatch(/uvx |npx |npm install|az login|--profile|--config|--tenant|FALCON_AXI_CLIENT_SECRET|LDAP_AXI_BIND_PASSWORD|AZ_AXI_READ_ONLY|VECTRA_AXI_READ_ONLY|\.\.\/\.\.\//)
  expect(skill).not.toMatch(new RegExp('`' + tool + '(?: |`)'))
  expect(skill).not.toMatch(/artium-axi (?:az|mg|vectra)-axi (?:setup|config|profile|login|auth login)/)
  expect(skill).toContain(tool === 'awx-axi' ? 'job list --limit 1 --help' : tool === 'ado-axi' ? 'project list --limit 1 --help' : tool === 'ldap-axi' ? 'entry search --help' : tool === 'falcon-axi' ? 'cve show <CVE-ID>' : tool === 'az-axi' ? 'rg query --file query.kql' : tool === 'mg-axi' ? 'entra user list' : 'detection list')
})

test.each([
  { tool: 'vectra-axi' as const, source: 'tools/node_modules/@knowttl/vectra-axi/skills/vectra-axi/SKILL.md', examples: ['artium-axi vectra-axi host list --name <text>', 'artium-axi vectra-axi detection show <id> --full'] },
  { tool: 'ldap-axi' as const, source: 'tools/node_modules/@knowttl/ldap-axi/skills/ldap-axi/SKILL.md', examples: ['artium-axi ldap-axi user groups <identifier-or-dn>', '--fields name,description,display_name'] },
  { tool: 'falcon-axi' as const, source: 'test/fixtures/falcon-SKILL.md', examples: ['artium-axi falcon-axi search start --query', 'artium-axi falcon-axi search status <id> --wait 30', '1-50 seconds', 'formatTime(', 'Stop search jobs when no longer needed.'] },
].flatMap(({ tool, source, examples }) => examples.map(example => ({ tool, source, example }))))('$tool generated skill retains $example', ({ tool, source, example }) => {
  const skill = loadToolSkill(tool, source)
  expect(skill).toContain(example)
})

test('unreviewed upstream skill content is refused before it is served', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-skill-'))
  const path = join(directory, 'SKILL.md')
  try {
    writeFileSync(path, readFileSync('tools/node_modules/@knowttl/az-axi/skills/az-axi/SKILL.md', 'utf8') + '\nRun standalone login\n')
    expect(() => loadToolSkill('az-axi', path)).toThrow('has not been reviewed')
    expect(() => loadToolSkill('az-axi', join(directory, 'missing'))).toThrow('unavailable')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
