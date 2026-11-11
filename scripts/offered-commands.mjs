import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = new URL('../tools/', import.meta.url)
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const inventory = tool => json(`inventories/${tool}.json`)
const upstreamFile = (tool, path) => new URL(`node_modules/@knowttl/${tool}/${path}`, root)
const covers = (patterns, command) => patterns.some(pattern => command === pattern || command.startsWith(pattern + ' '))
const words = text => text.split(' ').filter(Boolean)

export const pinnedGhBinary = fileURLToPath(new URL('node_modules/gh-axi/dist/bin/gh-axi.js', root))

function ghHelp(binary, args) {
  const result = spawnSync(process.execPath, [binary, ...args, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  if (result.status !== 0) throw new Error(`gh-axi ${args.join(' ')} --help failed: ${result.stderr}`)
  return result.stdout
}

function ghEntries(help, name) {
  const match = help.match(new RegExp(`^${name}(?:\\[\\d+\\])?:\\n\\s+(.*)$`, 'm'))
  return match ? match[1].split(/, (?![^<]*>)/).map(entry => words(entry)[0]) : null
}

export function ghSurface(binary = pinnedGhBinary) {
  const entry = inventory('gh-axi')
  const groups = ghEntries(ghHelp(binary, []), 'commands').map(name => name === '(none)=dashboard' ? 'home' : name)
  const offered = groups.flatMap(group => {
    if (group === 'home') return [group]
    const help = ghHelp(binary, [group])
    const verbs = ghEntries(help, 'subcommands') ?? ghEntries(help, 'types')
    return verbs ? verbs.flatMap(verb => (ghEntries(help, verb) ?? ['']).map(nested => `${group} ${verb} ${nested}`.trim())) : [group]
  })
  const blocked = entry.adapterBoundary.blockedCommands
  const admitted = new Set(entry.commands.map(route => route.command))
  return { groups, knownGroups: [...entry.discovery.commands, ...blocked.map(command => words(command)[0])],
    offered, admits: command => admitted.has(command), blocked }
}

export function unknownGhGroups(binary = pinnedGhBinary) {
  const { groups, knownGroups } = ghSurface(binary)
  return groups.filter(group => !knownGroups.includes(group))
}

const adoToken =/^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/
function adoPaths(tokens) {
  const end = tokens.findIndex(token => !adoToken.test(token))
  const matched = tokens.slice(0, end === -1 ? undefined : end)
  return { paths: matched.reduce((paths, token) => paths.flatMap(path => token.split('|').map(part => [...path, part])), [[]]),
    stop: end === -1 ? '' : tokens[end] }
}

export async function adoSurface(helpModule = upstreamFile('ado-axi', 'dist/help.js')) {
  const entry = inventory('ado-axi')
  const { COMMAND_HELP } = await import(helpModule.href)
  const offered = Object.entries(COMMAND_HELP).flatMap(([group, text]) => {
    const [header, ...lines] = text.split('\n')
    const alternatives = header.match(new RegExp(`^ado-axi ${group} <([a-z|-]+)>$`))?.[1].split('|') ?? []
    const usage = [header, ...lines].filter(line => line.startsWith('ado-axi ')).map(line => adoPaths(words(line).slice(1)).paths[0])
    const verbs = lines.filter(line => /^[a-z]/.test(line) && !line.startsWith('ado-axi ')).map(line => adoPaths(words(line.split(/ {2,}/)[0])))
      .filter(({ paths, stop }) => paths[0].length && /^(?:$|[<[(#-])/.test(stop)).flatMap(({ paths }) => paths.map(path => [group, ...path]))
    return [[group], ...alternatives.map(verb => [group, verb]), ...usage, ...verbs].map(path => path.join(' '))
  })
  const admitted = entry.commands.flatMap(route => [route.command, ...route.aliases])
  return { offered, admits: command => admitted.some(route => route === command || route.startsWith(command + ' ')),
    blocked: entry.adapterBoundary.blockedCommands }
}

function ldapSurface() {
  const entry = inventory('ldap-axi')
  const source = readFileSync(upstreamFile('ldap-axi', 'dist/src/cli-main.js'), 'utf8')
  const groups = [...source.match(/const commandGroups = \{([\s\S]*?)\n\};/)[1].matchAll(/(\w+): \[/g)].map(match => match[1])
  const offered = [...source.match(/const commandFlags = \{([\s\S]*?)\n\};/)[1].matchAll(/(?:^|[,{])\s*"?([a-z]+(?: [a-z]+)*)"?: \[/gm)]
    .map(match => match[1]).filter(command => !groups.includes(command))
  const admitted = new Set(entry.commands.map(route => route.command))
  return { offered, admits: command => admitted.has(command), blocked: entry.adapterBoundary.blockedCommands }
}

function proxmoxSurface() {
  const entry = inventory('proxmox-axi')
  const admitted = new Set(entry.commands.map(route => route.command))
  return { offered: json(`node_modules/@knowttl/proxmox-axi/artium-invocations.json`).commands.map(route => route.command),
    admits: command => admitted.has(command), blocked: entry.adapterBoundary.blockedCommands }
}

function giteaSurface() {
  const entry = inventory('gitea-axi')
  const admitted = new Set(entry.commands.map(route => route.command))
  return { offered: json('node_modules/@knowttl/gitea-axi/generated/host-inventory.json').commands.map(route => route.path.join(' ')),
    admits: command => admitted.has(command), blocked: entry.adapterBoundary.blockedCommands }
}

function shodanSurface() {
  const entry = inventory('shodan-axi')
  const admitted = new Set([...entry.commands, ...entry.streamCommands, ...entry.confirmedWrites].map(route => route.command))
  return { offered: json('node_modules/@knowttl/shodan-axi/command-inventory.json').commands.map(route => route.command),
    admits: command => admitted.has(command), blocked: [] }
}

async function mgSurface() {
  const { adapterBoundary } = inventory('mg-axi')
  const { LEAVES } = await import(upstreamFile('mg-axi', 'dist/catalogue.js').href)
  return { offered: LEAVES.map(leaf => leaf.path),
    admits: command => covers(adapterBoundary.allowedCommands, command) || adapterBoundary.downloadCommands.includes(command), blocked: [] }
}

export const surfaces = { 'gh-axi': ghSurface, 'ado-axi': adoSurface, 'ldap-axi': ldapSurface, 'proxmox-axi': proxmoxSurface,
  'gitea-axi': giteaSurface, 'shodan-axi': shodanSurface, 'mg-axi': mgSurface }

export async function unadmittedCommands(tool) {
  const { offered, admits, blocked } = await surfaces[tool]()
  return [...new Set(offered)].filter(command => !admits(command) && !covers(blocked, command)).sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reviewed = Object.fromEntries(await Promise.all(Object.keys(surfaces).map(async tool => [tool, await unadmittedCommands(tool)])))
  writeFileSync(new URL('offered-review.json', root), JSON.stringify(reviewed, null, 2) + '\n')
  console.log(`offered commands: ${Object.entries(reviewed).map(([tool, commands]) => `${tool} ${commands.length} unadmitted`).join(', ')}`)
}
