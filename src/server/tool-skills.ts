import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ArtiumError } from '../shared/errors.js'
import { toolManifests } from '../shared/tool-manifests.js'
import awxInventory from '../../tools/inventories/awx-axi.json' with { type: 'json' }
import { toolSkillPaths } from './config.js'
import type { ToolName } from './store/credential-store.js'

// Each digest binds an overlay review to the complete pinned upstream skill.
// New upstream content must be reviewed before it can reach an agent.
const overlays = {
  'hybrid-axi': { sha256: '1d0266cf0237630d063531b567a6b960dca48a731e7917e72b50fb59f757d384', sections: [] },
  'tenable-axi': { sha256: 'ea35fe90d39fee3982f731ccc3c717c92aabd0799ff2371f6f3cc5e12d7aea9a', sections: [] },
  'awx-axi': { sha256: awxInventory.skillSha256, sections: ['Output and errors'] },
  'ado-axi': { sha256: 'a187cf298038b30b5ea747c8d53304fc5c1c5522d7a5a957989a770190e1cb05', sections: ['Work items', 'Pull requests', 'Pipelines', 'Tests', 'Repositories'] },
  'az-axi': { sha256: 'a5df0a4e7603f8c960eacd2b57c3353b74b4c0ba0665d1d850374a90cc773123', sections: ['Reads', 'Safe shell input', 'Writes', 'Conventions'] },
  'vectra-axi': { sha256: 'a9fb66ac59a325958e19470286f27e8d2e1e9e65a4e93f5ee93fca6467fb2303', sections: ['Safety'] },
  'mg-axi': { sha256: 'f2867005e792f594662cee7883f6fc34617e5d59d06827e2403f0f5c7d76397b', sections: ['Safety'] },
  'ldap-axi': { sha256: 'e20365f41164061268067d0caa6055fe8417dc6c610d70a5c3108d1e6ae0dcfc', sections: ['Workflow', 'Safety'] },
  'falcon-axi': { sha256: 'dd23eead91a3f0a5e8d2265ae6f8a628f27c1f9981678ff1c23a24f6b0a6f43a', sections: ['Read-only boundary', 'Orientation', 'Credentials and output', 'Read-only RTR execution'] },
} as const

export function loadToolSkill(tool: ToolName, path: string = toolSkillPaths[tool]): string {
  try {
    const source = readFileSync(path, 'utf8')
    const overlay = overlays[tool]
    if (createHash('sha256').update(source).digest('hex') !== overlay.sha256) throw new Error('Unreviewed skill')
    let frontmatter = source.match(/^---\n[\s\S]*?\n---\n/)![0]
    const sections = overlay.sections.map(title => {
      const start = source.indexOf(`\n## ${title}\n`)
      const end = source.indexOf('\n## ', start + 1)
      return source.slice(start, end === -1 ? undefined : end).trim()
    })
    let body = sections.join('\n\n')
    if (tool === 'hybrid-axi') {
      frontmatter = frontmatter.replace(/^description:.*$/m, 'description: Investigate Hybrid Analysis through Artium with administrator-selected writes and authenticated CLI archive saving.')
      body = '## Managed investigation and writes\n\nUse `artium-axi hybrid-axi quota`, hash show, report show, search terms and hunting yara list for investigation.\nArtium manages one API key and the fixed Hybrid Analysis origin.\nSubmissions, YARA mutations, consuming matches and four reviewed archive downloads are off by default and selected independently by an administrator; native preview, --execute, exact --confirm and durable journal remain required.\nSandbox submission previews disclose community visibility. Consuming matches marks results delivered; never replay an ambiguous outcome. Reconcile its audit ID and journal.\nQuick scans are read exceptions that transmit the supplied sample or URL.\nFile flags accept uploaded leaf names only; body-file also accepts explicit stdin (-). Server paths are unavailable.\nUse `artium-axi download --help` for authenticated one-shot CLI verified saving of hash-download-bin, report-download-bin, report-download-dropped-files and report-download-memory after operator prerequisites pass. Ordinary tool-run downloads and browser artifact saving are blocked.\nLive malware: this archive may contain executable malware. Save only; do not extract or execute. Password protection is unverified; bytes are saved exactly as provided.\nDownloads require fresh identity proof, an exact new destination and explicit execution within the absolute ten-minute expiry; never retry an uncertain outcome. Administrator selection cannot grant upstream download entitlement.\nLabs contracts are experimental; preserve filters and query IDs when resuming bounded reads. A denial or malformed result is never an empty result.\nRun each command with --help for selectors, defaults and examples.\n'
      body += '\nManaged commands: ' + toolManifests['hybrid-axi'].commands.filter(route => route.effect !== 'blocked').map(route => '`artium-axi hybrid-axi ' + route.command + '`').join(', ') + '.\n'
    } else if (tool === 'tenable-axi') {
      body = '## Managed investigation and writes\n\nUse `artium-axi tenable-axi card list --limit 1`, asset list, finding list, software list and attack-path list to investigate exposure.\nArtium manages both secret API keys and the fixed https://cloud.tenable.com origin.\nWrites and export-job creation require administrator-enabled operations, native preview, --execute and the exact preview --confirm string.\nNever replay an unknown mutation outcome; follow its audit ID and read-back guidance.\nFile flags accept uploaded leaf names or explicit stdin (-); server paths and output downloads are unavailable.\nUsers, roles, access control, credential minting and arbitrary HTTP are unavailable.\nLists are bounded; preserve filters, sort and fields when resuming a cursor.\nRun each command with --help for selectors, defaults and examples.\n'
      body += '\nManaged commands: ' + toolManifests['tenable-axi'].commands.filter(route => route.effect !== 'blocked').map(route => '`artium-axi tenable-axi ' + route.command + '`').join(', ') + '.\n'
    } else if (tool === 'awx-axi') {
      frontmatter = frontmatter.replace(/^description:.*$/m, 'description: Inspect AWX resources and perform administrator-enabled operational actions through Artium. Configuration, deletion and security writes are blocked.')
      body = body.replaceAll('npx -y awx-axi', 'artium-axi awx-axi')
      body += '\n\n## Managed commands\n\nOperational writes require administrator allowWrites and --confirm; configuration, deletion and security writes are blocked. No stdin or files. Artium manages the HTTPS origin and token; administrators inspect certificates and trust per host in the tool page.\nUse job list and job show to inspect runs, job stdout for output, and job watch --timeout 50 for bounded polling.\nRead commands: ' + awxInventory.commands.filter(route => route.effect === 'read').map(route => '`' + route.command + '`').join(', ') + '.\nOperational commands: ' + awxInventory.commands.filter(route => route.effect === 'write').map(route => '`' + route.command + '`').join(', ') + '.\n'
    } else if (tool === 'ado-axi') {
      body = body.replace(/\n### Safe shell input\n[\s\S]*?(?=\n### |\n## |$)/, '')
        .replace(/\n### Git Bash repository paths\n[\s\S]*?(?=\n### |\n## |$)/, '')
        .replaceAll('--timeout 1800', '--timeout 50')
      body += '\n\n## Managed access\n\nArtium manages the organization, profile, config and PAT.\nWrites are off by default and journaled by Artium only.\nThe api command accepts relative paths and GET only, without body flags.\nStdin and files are unsupported; pass comment and description text as flag values.\nFor pipeline watch, use --timeout 50 or less.\n'
    } else if (tool === 'az-axi') {
      body = body.replace(' Launch agents that must never write with `AZ_AXI_READ_ONLY=1`.', '')
    } else if (tool === 'vectra-axi') {
      body = body.replace('the profile must hand-enable the operation in its `writes` scope, and `VECTRA_AXI_READ_ONLY=1` forces read-only for the whole process.', 'the administrator must enable the operation in its managed write scope.')
      body = body.replace('`entity show`', '`artium-axi vectra-axi entity show <id>`')
      body += '\n\n## Investigation reads\n\nFind a host with `artium-axi vectra-axi host list --name <text>`, then use `artium-axi vectra-axi detection list --host-id <id>`.\nInspect details with `artium-axi vectra-axi detection show <id> --full`; use either a positional ID or --id, never both.\nDetection --fields supports first_timestamp,last_timestamp,src_ip,src_host,summary,grouped_details.\n'
    } else if (tool === 'mg-axi') {
      frontmatter = frontmatter.replace(', Defender XDR advanced hunting', '')
      body = body.replace('Reads run through a session that authorizes only catalogued operations before silent credential acquisition; only explicit `auth login` opens a browser or prints a device-code challenge.', 'Reads authorize only catalogued operations with Artium-managed credentials.')
      body = body.replace('Secrets stay in credential references, never in argv, config files or output; credential fields carry expiry metadata only.', 'Artium supplies credentials on the server; never put secrets in argv or output.')
    } else if (tool === 'ldap-axi') {
      body = body.replace('`group list`', '`artium-axi ldap-axi group list`').replace('`auth status --offline`', '`artium-axi ldap-axi auth status --offline`')
      body += '\n\nUse `artium-axi ldap-axi user groups <identifier-or-dn>` for group membership.\nFor AD user details, request `artium-axi ldap-axi user show <identifier-or-dn> --fields name,description,display_name`; --attributes accepts LDAP attribute names such as displayName.\n'
    } else if (tool === 'falcon-axi') {
      body = body.split('\n').filter(line => !/^(Secrets belong|Use `--profile|Use `--member-cid)/.test(line)).join('\n')
        .replaceAll('uvx falcon-axi', 'falcon-axi')
      body += '\n\nArtium must enable RTR read-only command execution separately from the managed profile rtr.enabled opt-in. History reads remain available while execution is off.\nMalQuery search is a separate administrator capability, off by default, requiring MalQuery:write. Only bounded exact/fuzzy searches are available; hunt and sample downloads remain excluded.\n'
    }
    const registry = source.match(/<!-- command-registry:start -->\n([\s\S]*?)\n<!-- command-registry:end -->/)
    let commands = ''
    if (registry) {
      const allowed = new Set(toolManifests[tool].commands.filter(route => {
        if (tool === 'az-axi') return 'tokenResources' in route && route.tokenResources !== null
        if (tool === 'mg-axi') return toolManifests['mg-axi'].adapterBoundary.allowedCommands
          .some(command => route.command === command || route.command.startsWith(`${command} `))
        return !/^(setup|config|profile)\b/.test(route.command)
      }).map(route => route.command))
      commands = '## Commands\n\n' + registry[1].split('\n').filter(line => {
        const command = line.match(/^\| `\S+ (.*?)` \|/)
        return !command || allowed.has(command[1])
      }).join('\n')
    }
    // Retain operational guidance, removing standalone setup, selectors and auth sections.
    const invocation = `artium-axi ${tool}`
    let content = `${frontmatter}\n# ${tool}\n\nRun every command through \`${invocation}\` after signing in to Artium.\nArtium supplies the managed credentials and connection settings on the server.\nDo not install the upstream CLI, configure local credentials, select a profile or tenant, or run standalone login/setup commands.\nAdministrators control tool access and write permissions.\nRun \`artium-axi tools\` for current access and \`${invocation} ${toolManifests[tool].discovery.example.join(' ')} --help\` for command guidance.\n\n${commands ? commands + '\n\n' : ''}${body}\n`
    content = content.replaceAll(`npx -y @knowttl/${tool}`, invocation)
    if (tool === 'ado-axi') content = content.replace(/^ado-axi(?=\s|$)/gm, invocation).replaceAll('MSYS_NO_PATHCONV=1 ado-axi', invocation)
    // Bare upstream commands occur in tables and inline examples after a backtick.
    content = content.replaceAll('`' + tool, '`' + invocation)
    content = content.replace(/\]\(\.\.\/\.\.\/([^)]*)\)/g, `](https://github.com/knowttl/${tool}/blob/v${toolManifests[tool].version}/$1)`)
    return content
  } catch {
    throw new ArtiumError('INTERNAL_ERROR', `The ${tool} skill is unavailable or has not been reviewed for managed use.`, 'Ask an administrator to repair the bundled tool skill; no installation was written.')
  }
}
