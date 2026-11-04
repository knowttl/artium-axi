import inventory from '../../tools/inventories/technitium-axi.json' with { type: 'json' }
import { ArtiumError } from './errors.js'
import type { RunInput } from './api.js'

export const technitiumSecretNames = new Set([...inventory.writeContracts.flatMap(contract => contract.secrets), 'sharedSecret', 'proxyPassword'])
export const technitiumObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export interface TechnitiumInput {
  parameters: Record<string, unknown>
  baseline?: Record<string, unknown>
  upload?: { file: string, format?: string }
  encoding?: string
  secrets?: Record<string, string>
}

// The hosted envelope may reference only its explicit secrets and uploaded assets.
export function technitiumInput(operation: string, name: string, input: RunInput): { body: TechnitiumInput, assets: string[] } {
  const file = input.files?.find(file => file.name === name)
  let value: unknown
  try { value = JSON.parse(Buffer.from(file?.contentBase64 ?? '', 'base64').toString('utf8')) } catch { throw new ArtiumError('INVALID_INPUT') }
  if (!technitiumObject(value) || !technitiumObject(value.parameters)
    || Object.keys(value).some(key => !['parameters', 'baseline', 'upload', 'encoding', 'secrets'].includes(key))
    || value.baseline !== undefined && !technitiumObject(value.baseline)) throw new ArtiumError('INVALID_INPUT')
  const parameters = value.parameters
  if (operation === 'OP-003' && ['user', 'pass', 'totp'].some(key => Object.hasOwn(parameters, key))) throw new ArtiumError('FLAG_BLOCKED')
  const secrets = value.secrets ?? {}
  if (!technitiumObject(secrets) || Object.entries(secrets).some(([key, secret]) => !/^TECHNITIUM_INPUT_[A-Z0-9_]+$/.test(key)
    || typeof secret !== 'string' || secret.includes('\0') || Buffer.byteLength(secret) > 65536)
    || Buffer.byteLength(JSON.stringify(secrets)) > 65536) throw new ArtiumError('INVALID_INPUT')
  const assets: string[] = []
  const used = new Set<string>()
  const asset = (path: unknown) => {
    if (typeof path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path) || path === name
      || !input.files?.some(file => file.name === path)) throw new ArtiumError('FLAG_BLOCKED')
    assets.push(path)
  }
  if (value.upload !== undefined) {
    if (!['OP-022', 'OP-023', 'OP-072', 'OP-073', 'OP-085'].includes(operation) || !technitiumObject(value.upload)
      || Object.keys(value.upload).some(key => !['file', 'format'].includes(key))) throw new ArtiumError('INVALID_INPUT')
    asset(value.upload.file)
  }
  if (operation === 'OP-076' && value.parameters.config !== undefined) {
    if (!technitiumObject(value.parameters.config) || Object.keys(value.parameters.config).join(',') !== 'file') throw new ArtiumError('FLAG_BLOCKED')
    asset(value.parameters.config.file)
  }
  const visit = (node: unknown, key = '', depth = 0): void => {
    if (depth > 24) throw new ArtiumError('INVALID_INPUT')
    if (technitiumSecretNames.has(key)) {
      if (!technitiumObject(node) || Object.keys(node).join(',') !== 'env' || typeof node.env !== 'string'
        || !Object.hasOwn(secrets, node.env)) throw new ArtiumError('FLAG_BLOCKED')
      used.add(node.env)
    } else if (Array.isArray(node)) for (const item of node) visit(item, '', depth + 1)
    else if (technitiumObject(node)) for (const [name, child] of Object.entries(node)) {
      if (['env', 'file'].includes(name)) throw new ArtiumError('FLAG_BLOCKED')
      if (operation === 'OP-076' && key === '' && name === 'config') continue
      visit(child, name, depth + 1)
    }
  }
  visit(value.parameters)
  if (value.baseline) visit(value.baseline)
  if (Object.keys(secrets).some(key => !used.has(key))) throw new ArtiumError('INVALID_INPUT')
  if (input.files?.some(file => file.name !== name && !assets.includes(file.name))) throw new ArtiumError('UNSUPPORTED_INPUT')
  return { body: value as unknown as TechnitiumInput, assets }
}
