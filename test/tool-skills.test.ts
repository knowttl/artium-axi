import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadToolSkill } from '../src/server/tool-skills.js'
import { toolSchema } from '../src/shared/api.js'

test.each(toolSchema.options)('%s overlay preserves tool guidance with managed command examples', tool => {
  const source = tool === 'gh-axi' ? 'tools/node_modules/gh-axi/skills/gh-axi/SKILL.md' : tool === 'awx-axi' ? 'tools/skills/awx-axi/SKILL.md' : tool === 'ado-axi' ? 'tools/node_modules/@knowttl/ado-axi/SKILL.md' : `tools/node_modules/@knowttl/${tool}/skills/${tool}/SKILL.md`
  const skill = loadToolSkill(tool, tool === 'unifi-axi' ? 'tools/node_modules/@knowttl/unifi-axi/dist/SKILL.md'
    : tool === 'proxmox-axi' || tool === 'technitium-axi' || tool === 'ssh-axi' ? `tools/node_modules/@knowttl/${tool}/README.md` : tool === 'gitea-axi' ? 'tools/node_modules/@knowttl/gitea-axi/generated/SKILL.md' : source)
  expect(skill).toContain(`name: ${tool}`)
  expect(skill).toContain(`artium-axi ${tool}`)
  if (tool === 'ssh-axi') {
    expect(skill).toContain('doctor <host>')
    expect(skill).toContain('every resolved address must belong to the approved literal address set')
    expect(skill).toContain('ordinary calls never fall back to sudo or generic credentials')
    return
  }
  if (tool === 'kubernetes-axi') {
    expect(skill).toContain('native -- get deployments -o json')
    expect(skill).toContain('saved strict leaf pins are unavailable')
    expect(skill).toContain('Secret reads expose metadata only')
    return
  }
  if (tool === 'technitium-axi') {
    expect(skill).toContain('same user with current access and the same credential revision')
    expect(skill).toContain('five minutes')
    return
  }
  if (tool === 'gitea-axi') {
    expect(skill).toContain('issue view 42 --repo OWNER/NAME --help')
    expect(skill).toContain('api GET repos/OWNER/NAME')
    expect(skill).toContain('Writes default off and require administrator Allow writes plus exact native operation IDs.')
    expect(skill).toContain('Secret set requires protected --input; variables are non-secret and retain native value readback.')
    expect(skill).toContain('Upload opaque attachments with --file or --attach, never stdin')
    expect(skill).toContain('gitea.issue.download, gitea.pr.download or gitea.release.download')
    expect(skill).toContain('Pending workflow commands, local workflows and credential routes are unavailable.')
    return
  }
  if (tool === 'unifi-axi') {
    expect(skill).toContain('--execute --confirm <digest> --request-id <stable-id>')
    expect(skill).toContain('createNetwork and createNetwork:UNMANAGED')
    expect(skill).toContain('write reconcile --request-id <id>')
    expect(skill).toContain('Writes default to preview without mutation.')
    return
  }
  if (tool === 'proxmox-axi') {
    expect(skill).toContain('get /version --help')
    expect(skill).toContain('independent administrator hostWrites operation list')
    expect(skill).toContain('--confirm <id.fingerprint>')
    expect(skill).toContain('journal reconcile <id>')
    expect(skill).toContain('users need no separate Proxmox sign-in')
    expect(skill).toContain('result take <operation> <id>')
    expect(skill).toContain('TFA accounts cannot sign in automatically')
    expect(skill).toContain('private firewall and node-network reads are unavailable')
    return
  }
  expect(skill).toContain('Artium supplies the managed credentials')
  expect(skill).not.toMatch(/uvx |npx |npm install|az login|--profile|--config|--tenant|FALCON_AXI_CLIENT_SECRET|LDAP_AXI_BIND_PASSWORD|AZ_AXI_READ_ONLY|VECTRA_AXI_READ_ONLY|\.\.\/\.\.\//)
  expect(skill).not.toMatch(new RegExp('`' + tool + '(?: |`)'))
  expect(skill).not.toMatch(/artium-axi (?:az|mg|vectra)-axi (?:setup|config|profile|login|auth login)/)
  expect(skill).toContain(tool === 'gh-axi' ? 'repo list --limit 1 --help' : tool === 'beyondtrust-axi' ? 'computer list --limit 1 --help' : tool === 'checkpoint-axi' ? 'email search --limit 1 --help' : tool === 'hybrid-axi' ? 'quota --help' : tool === 'tenable-axi' ? 'card list --limit 1 --help' : tool === 'awx-axi' ? 'job list --limit 1 --help' : tool === 'ado-axi' ? 'project list --limit 1 --help' : tool === 'ldap-axi' ? 'user list --limit 1 --help' : tool === 'falcon-axi' ? 'cve show <CVE-ID>' : tool === 'az-axi' ? 'rg query --file query.kql' : tool === 'mg-axi' ? 'entra user list' : 'detection list')
})

test.each([
  { tool: 'mg-axi' as const, source: 'tools/node_modules/@knowttl/mg-axi/skills/mg-axi/SKILL.md', examples: ['artium-axi mg-axi security hunting query --file query.kql', 'enabledPacks: ["entra", "security"]', '64 KiB', 'enabledPacks: ["entra", "mail"]', 'mail message list --mailbox', 'The run API accepts the cursor token in stdin with --cursor -', 'the bundled CLI does not capture Graph cursor stdin, so use --cursor <token> there.', 'untrusted data written by outside senders', 'Exchange RBAC for Applications', 'mail.message.tag', 'rule.json', 'at most 20'] },
  { tool: 'vectra-axi' as const, source: 'tools/node_modules/@knowttl/vectra-axi/skills/vectra-axi/SKILL.md', examples: ['artium-axi vectra-axi host list --name <text>', 'artium-axi vectra-axi detection show <id> --full'] },
  { tool: 'ldap-axi' as const, source: 'tools/node_modules/@knowttl/ldap-axi/skills/ldap-axi/SKILL.md', examples: ['artium-axi ldap-axi user groups <identifier-or-dn>', '--fields name,description,display_name'] },
  { tool: 'falcon-axi' as const, source: 'tools/node_modules/@knowttl/falcon-axi/skills/falcon-axi/SKILL.md', examples: ['artium-axi falcon-axi detection list', 'artium-axi falcon-axi search status <id> --wait 30', '1-50 seconds', 'Identity Protection GraphQL permission', 'Search and MalQuery submissions follow the native immediate-dispatch model'] },
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
