import { createHash } from 'node:crypto'
import adoInventory from '../../../tools/inventories/ado-axi.json' with { type: 'json' }
import awxInventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import azInventory from '../../../tools/inventories/az-axi.json' with { type: 'json' }
import falconInventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import ghInventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import giteaInventory from '../../../tools/inventories/gitea-axi.json' with { type: 'json' }
import hybridInventory from '../../../tools/inventories/hybrid-axi.json' with { type: 'json' }
import kubernetesInventory from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import mgInventory from '../../../tools/inventories/mg-axi.json' with { type: 'json' }
import tenableInventory from '../../../tools/inventories/tenable-axi.json' with { type: 'json' }
import vectraInventory from '../../../tools/inventories/vectra-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { hybridBooleanFlags } from '../adapters/hybrid.js'
import { tenableBooleanFlags } from '../adapters/tenable.js'
import type { Adapter } from '../adapters/types.js'
import type { RunnerInput } from '../runner/input.js'

export interface RawApiRoutes { get: string[], write: string[] }
export interface RawApiCall {
  method: string
  path: string | null
  query: { name: string, sha256: string }[]
  bodySha256: string
  bodyBytes: number
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const writeMethods = ['POST', 'PATCH', 'PUT', 'DELETE']

export function canonicalizePath(path: string): string {
  return path.split('/').map(segment => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new ArtiumError('FLAG_BLOCKED') }
    if (!decoded || ['.', '..'].includes(decoded) || /[/%?#\\:\x00-\x1f\x7f]/.test(decoded)) throw new ArtiumError('FLAG_BLOCKED')
    try { return encodeURIComponent(decoded) } catch { throw new ArtiumError('FLAG_BLOCKED') }
  }).join('/')
}

function routePath(target: string): string | null {
  const path = target.replace(/^\//, '').replace(/\/$/, '')
  if (!path || /[?#\\\s:]/.test(path)) return null
  try { return canonicalizePath(path) } catch { return null }
}

interface Inventory {
  commands: readonly { command: string, flags?: Readonly<Record<string, string | undefined>>, shortFlags?: Readonly<Record<string, string | undefined>> }[]
}
interface Reader {
  inventory: Inventory
  booleans?: readonly string[]
  shorts?: Readonly<Record<string, string>>
  queryFlags?: readonly string[]
  request(positionals: string[], flags: Map<string, string[]>, input: RunnerInput):
    { method: string, target: string, body: string | Uint8Array, query?: [string, string][] }
}

function scan(args: readonly string[], reader: Reader, raw: readonly string[]) {
  const isRaw = (command: string) => raw.some(name => command === name || command.startsWith(`${name} `))
  const routes = [...reader.inventory.commands.filter(route => !isRaw(route.command)), ...reader.inventory.commands.filter(route => isRaw(route.command))]
  const types: Record<string, string> = Object.assign({}, ...routes.map(route => route.flags))
  const values = Object.keys(types).filter(name => !['boolean', 'boolean-value'].includes(types[name]) && !reader.booleans?.includes(name))
  const shorts: Record<string, string> = Object.assign({}, ...routes.map(route =>
    Object.fromEntries(Object.entries(route.shortFlags ?? {}).map(([short, name]) => [`-${short}`, name]))), reader.shorts)
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-') || token === '-') { positionals.push(token); continue }
    const [flag, ...inline] = token.split('=')
    const name = shorts[flag] ?? flag.replace(/^--?/, '')
    const value = inline.length ? inline.join('=') : values.includes(name) ? args[++index] ?? ''
      : ['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true'
    flags.set(name, [...flags.get(name) ?? [], value])
  }
  return { positionals, flags }
}

const verb = /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/i
const last = (flags: Map<string, string[]>, name: string) => flags.get(name)?.at(-1)
function fileBody(name: string | undefined, input: RunnerInput): string | Uint8Array {
  if (name === undefined) return ''
  if (name === '-') return input.stdin ?? ''
  const file = input.files?.find(file => file.name === name)
  return file ? Buffer.from(file.contentBase64, 'base64') : ''
}
const bodyFile = (flags: Map<string, string[]>, input: RunnerInput) => fileBody(last(flags, 'body-file'), input)
function jsonQuery(name: string | undefined, input: RunnerInput): [string, string][] {
  if (name === undefined) return []
  try {
    return Object.entries(JSON.parse(Buffer.from(fileBody(name, input)).toString()) as Record<string, unknown>)
      .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item): [string, string] => [key, String(item)]))
  } catch { return [] }
}
const nativeRequest: Reader['request'] = (positionals, flags, input) => ({
  method: positionals[1]?.toLowerCase() === 'write' ? (last(flags, 'method') ?? '').toUpperCase() : 'GET',
  target: last(flags, 'path') ?? '', body: bodyFile(flags, input), query: jsonQuery(last(flags, 'query-file'), input) })

const readers: Record<string, Reader> = {
  'ado-axi': { inventory: adoInventory, shorts: { '-X': 'method' }, queryFlags: ['query'], request: (positionals, flags) => {
    const verbs = [last(flags, 'method')?.toUpperCase(), verb.test(positionals[1] ?? '') ? positionals[1].toUpperCase() : undefined]
    return { method: verbs.find(value => value && value !== 'GET') ?? 'GET', target: positionals[verbs[1] ? 2 : 1] ?? '', body: last(flags, 'body') ?? '' }
  } },
  'gh-axi': { inventory: ghInventory, shorts: { '-R': 'repo' }, request: (positionals, flags) => ({
    method: (last(flags, 'method') ?? (positionals.length === 3 ? positionals[1] : 'GET')).toUpperCase(), target: positionals.at(-1) ?? '', body: '' }) },
  'gitea-axi': { inventory: giteaInventory, request: (positionals, flags, input) => {
    const [pathname, ...query] = (positionals.at(-1) ?? '').split('?')
    const bare = pathname.replace(/^\//, '')
    return { method: (positionals.length === 3 ? positionals[1] : last(flags, 'method') ?? 'GET').toUpperCase(),
      target: [bare.startsWith('api/v1/') || bare === 'swagger.v1.json' ? bare : `api/v1/${bare}`, ...query].join('?'),
      body: flags.has('input') ? fileBody(last(flags, 'input'), input) : [...flags.get('field') ?? [], ...flags.get('raw-field') ?? []].join('&') }
  } },
  'az-axi': { inventory: azInventory, queryFlags: ['query'], request: (positionals, flags, input) => {
    let target = positionals[2] ?? ''
    try { const url = new URL(target, 'https://management.azure.com'); target = url.pathname + url.search } catch {}
    return { method: (positionals[1] ?? '').toUpperCase(), target, body: last(flags, 'body') ?? bodyFile(flags, input) }
  } },
  'awx-axi': { inventory: awxInventory, queryFlags: ['query'], request: (positionals, flags, input) => ({
    method: (positionals[1] ?? '').toUpperCase(), target: positionals[2] ?? '', body: bodyFile(flags, input) }) },
  'mg-axi': { inventory: mgInventory, queryFlags: ['query', 'odata'],
    request: (positionals, flags) => ({ method: (positionals[1] ?? '').toUpperCase(), target: positionals[2] ?? '', body: last(flags, 'body') ?? '' }) },
  'vectra-axi': { inventory: vectraInventory, queryFlags: ['query'], request: (_, flags) => ({ method: 'GET', target: last(flags, 'path') ?? '', body: '' }) },
  'hybrid-axi': { inventory: hybridInventory, booleans: hybridBooleanFlags,
    request: positionals => ({ method: 'GET', target: positionals[2] ?? '', body: '' }) },
  'falcon-axi': { inventory: falconInventory, queryFlags: ['query'], request: nativeRequest },
  'tenable-axi': { inventory: tenableInventory, booleans: tenableBooleanFlags, queryFlags: ['query'], request: nativeRequest },
  'kubernetes-axi': { inventory: kubernetesInventory, request: (positionals, flags) => ({
    method: positionals[0].toUpperCase(), target: positionals.slice(1).join('/'), body: '',
    query: ['namespace', 'selector', 'field-selector'].flatMap(name => (flags.get(name) ?? []).map((value): [string, string] => [name, value])) }) },
}

export function readRawApiCall(adapter: Adapter<unknown>, args: readonly string[], input: RunnerInput = {}): RawApiCall | undefined {
  const reader = readers[adapter.name]
  if (!adapter.rawApi || !reader) return undefined
  const native = adapter.name === 'kubernetes-axi'
  if (native && (args[0] !== 'native' || !args.includes('--'))) return undefined
  const { positionals, flags } = scan(native ? args.slice(args.indexOf('--') + 1) : args, reader, adapter.rawApi.commands)
  const raw = native ? !!positionals[0]
    : adapter.rawApi.commands.some(command => positionals.slice(0, command.split(' ').length).join(' ').toLowerCase() === command)
  if (!raw) return undefined
  let help: boolean
  try { help = adapter.rawApi.help(args, input) } catch { help = false }
  if (help) return undefined
  const { method, target, body, query = [] } = reader.request(positionals, flags, input)
  const texts = [target.split('?').slice(1).join('?'), ...(reader.queryFlags ?? []).flatMap(name => flags.get(name) ?? [])]
  return { method, path: routePath(target.split('?')[0]),
    query: [...texts.flatMap(text => [...new URLSearchParams(text)]), ...query].map(([name, value]) => ({ name, sha256: sha256(value) })),
    bodySha256: sha256(body), bodyBytes: Buffer.byteLength(body) }
}

function parsePattern(entry: string, write: boolean): { method?: string, segments: (string | null)[], prefix: boolean } {
  const [method, pattern, ...extra] = write ? entry.split(' ') : [undefined, entry]
  if (extra.length || write && !writeMethods.includes(method!) || !pattern || pattern.startsWith('/')) throw new ArtiumError('INVALID_INPUT')
  const segments = pattern.split('/')
  const prefix = segments.at(-1) === '**'
  if (prefix) segments.pop()
  if (segments.includes('**')) throw new ArtiumError('INVALID_INPUT')
  return { method, prefix, segments: segments.map(segment => segment === '*' ? null : canonicalizePath(segment)) }
}

export function validateRawApiRoutes(routes: RawApiRoutes): void {
  for (const [list, write] of [[routes.get, false], [routes.write, true]] as const) {
    for (const entry of list) {
      try { parsePattern(entry, write) } catch {
        throw new ArtiumError('INVALID_INPUT', `Invalid ${write ? 'write' : 'GET'} route pattern ${JSON.stringify(entry)}.`,
          write ? 'Use METHOD path, for example PATCH _apis/wit/workitems/*. METHOD is POST, PATCH, PUT or DELETE. A final ** matches any deeper path.'
            : 'Use a relative path such as _apis/wit/*. A final ** matches any deeper path.')
      }
    }
  }
}

export function matchRawApiRoute(list: readonly string[], write: boolean, call: Pick<RawApiCall, 'method' | 'path'>): string | undefined {
  if (call.path === null) return undefined
  const actual = call.path.split('/')
  return list.find(entry => {
    try {
      const { method, segments, prefix } = parsePattern(entry, write)
      return (method === undefined || method === call.method) && (prefix ? actual.length >= segments.length : actual.length === segments.length)
        && segments.every((segment, index) => segment === null || segment === actual[index])
    } catch { return false }
  })
}

export function upstreamStatus(stdout: string): number | null {
  const status = /^api_response:\r?\n(?:  .*\r?\n)*?  status: ([1-5]\d\d)\r?$/m.exec(stdout)?.[1]
  return status === undefined ? null : Number(status)
}
