import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ArtiumError } from '../shared/errors.js'
import { toolManifests } from '../shared/tool-manifests.js'
import { toolSkillPaths } from './config.js'
import type { ToolName } from './store/credential-store.js'

// Each digest binds an overlay review to the complete pinned upstream skill.
// New upstream content must be reviewed before it can reach an agent.
const overlays = {
  'az-axi': { sha256: '6bf268e08b707f5e0f41ac3a5d1f4fefdef515f0f710b2e1139dee1e2e517161', sections: ['Reads', 'Safe shell input', 'Writes', 'Conventions'] },
  'vectra-axi': { sha256: '0fef685ec7e7cc955a2d024901b4f25802c4b73240a561cce97567c68818430f', sections: ['Safety'] },
  'mg-axi': { sha256: '5c91de7c458ff8813998d9950b5447c9fed16d87225093019c1ef6ec3ad27c4f', sections: ['Safety'] },
  'ldap-axi': { sha256: 'cc21c3396ed8c23d752eb4fd3e670bd85250afc45ed8654111bf8f0972976ba2', sections: ['Workflow', 'Safety'] },
  'falcon-axi': { sha256: '5299d997f1e1a515d9056c609fe3e27d10796db135295f2cc801226e5916d056', sections: ['Workflow', 'Pagination'] },
} as const

export function loadToolSkill(tool: ToolName, path: string = toolSkillPaths[tool]): string {
  try {
    const source = readFileSync(path, 'utf8')
    const overlay = overlays[tool]
    if (createHash('sha256').update(source).digest('hex') !== overlay.sha256) throw new Error('Unreviewed skill')
    const frontmatter = source.match(/^---\n[\s\S]*?\n---\n/)![0]
    const sections = overlay.sections.map(title => {
      const start = source.indexOf(`\n## ${title}\n`)
      const end = source.indexOf('\n## ', start + 1)
      return source.slice(start, end === -1 ? undefined : end).trim()
    })
    let body = sections.join('\n\n')
    if (tool === 'az-axi') {
      body = body.replace(' Launch agents that must never write with `AZ_AXI_READ_ONLY=1`.', '')
    } else if (tool === 'vectra-axi') {
      body = body.replace('the profile must hand-enable the operation in its `writes` scope, and `VECTRA_AXI_READ_ONLY=1` forces read-only for the whole process.', 'the administrator must enable the operation in its managed write scope.')
      body = body.replace('`entity show`', '`artium-axi vectra-axi entity show <id>`')
    } else if (tool === 'mg-axi') {
      body = body.replace('Reads run through a session that authorizes only catalogued operations before silent credential acquisition; only explicit `auth login` opens a browser or prints a device-code challenge.', 'Reads authorize only catalogued operations with Artium-managed credentials.')
      body = body.replace('Secrets stay in credential references, never in argv, config files or output; credential fields carry expiry metadata only.', 'Artium supplies credentials on the server; never put secrets in argv or output.')
    } else if (tool === 'ldap-axi') {
      body = body.replace('`group list`', '`artium-axi ldap-axi group list`').replace('`auth status --offline`', '`artium-axi ldap-axi auth status --offline`')
    } else if (tool === 'falcon-axi') {
      body = body.replace('job with `search status`.', 'job with `artium-axi falcon-axi search status <id>`.')
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
    // Bare upstream commands occur in tables and inline examples after a backtick.
    content = content.replaceAll('`' + tool, '`' + invocation)
    content = content.replace(/\]\(\.\.\/\.\.\/([^)]*)\)/g, `](https://github.com/knowttl/${tool}/blob/v${toolManifests[tool].version}/$1)`)
    return content
  } catch {
    throw new ArtiumError('INTERNAL_ERROR', `The ${tool} skill is unavailable or has not been reviewed for managed use.`, 'Ask an administrator to repair the bundled tool skill; no installation was written.')
  }
}
