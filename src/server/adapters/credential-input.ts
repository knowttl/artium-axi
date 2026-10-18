import type { Ajv, ErrorObject, ValidateFunction } from 'ajv'
import type { FormatName } from 'ajv-formats'

type Schema = Record<string, any>
type Format = { validate: (value: string) => boolean, normalize: ((value: string) => string) | 'none', reason: string }

// Standard formats retain their validator's accepted spelling. Whitespace can
// still be repaired by the generic string rule when that validator rejects it.
export const standardCredentialFormats = {
  date: 'none', time: 'none', 'date-time': 'none', 'iso-time': 'none', 'iso-date-time': 'none', duration: 'none',
  uri: 'none', 'uri-reference': 'none', 'uri-template': 'none', url: 'none', email: 'none', hostname: 'none',
  ipv4: 'none', ipv6: 'none', regex: 'none', uuid: 'none', 'json-pointer': 'none',
  'json-pointer-uri-fragment': 'none', 'relative-json-pointer': 'none', byte: 'none', int32: 'none', int64: 'none',
  float: 'none', double: 'none', password: 'none', binary: 'none',
} satisfies Record<FormatName, 'none'>

export function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && value === url.origin && !url.username && !url.password
  } catch { return false }
}

function canonicalUrl(value: string, protocols: readonly string[]): string {
  // URL parsing silently discards some characters. Only an authority and an
  // optional root slash are safe to rebuild as a credential destination.
  if (!/^[a-z]+:\/\/[^\s\\/?#@]+\/?$/i.test(value)) return value
  try {
    const url = new URL(value)
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password) return value
    if (url.protocol === 'https:') return url.origin
    const port = url.port && url.port !== (url.protocol === 'ldaps:' ? '636' : '389') ? `:${url.port}` : ''
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}`
  } catch { return value }
}

export const credentialFormats: Record<string, Format> = {
  'canonical-https-origin': { validate: isCanonicalHttpsOrigin,
    normalize: value => canonicalUrl(value, ['https:']), reason: 'must be an HTTPS origin without a path, query, fragment or embedded credentials' },
  'ldap-url': { validate: value => {
    try {
      const url = new URL(value)
      return ['ldap:', 'ldaps:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
        && !url.search && !url.hash && ['', '/'].includes(url.pathname)
    } catch { return false }
  }, normalize: value => canonicalUrl(value, ['ldap:', 'ldaps:']),
  reason: 'must be an LDAP URL without a path, query, fragment or embedded credentials' },
}

export interface InputNormalization { field: string, reason: string }

// The same schema and validator own both normalization and validation. A valid
// subtree is returned immediately, including whitespace in accepted secrets.
export class CredentialInput {
  private readonly validators = new Map<string, ValidateFunction>()
  readonly validate: ValidateFunction

  constructor(private readonly schema: Schema, private readonly ajv: Ajv) {
    for (const [name, format] of Object.entries(credentialFormats)) ajv.addFormat(name, { type: 'string', validate: format.validate })
    ajv.addSchema(schema, 'urn:artium:credential-input')
    this.validate = this.validator('')
  }

  private validator(pointer: string): ValidateFunction {
    let validate = this.validators.get(pointer)
    if (!validate) {
      validate = this.ajv.compile({ $ref: `urn:artium:credential-input#${pointer}` })
      this.validators.set(pointer, validate)
    }
    return validate
  }

  private resolve(pointer: string): Schema {
    return pointer.split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], this.schema)
  }

  normalize(value: Record<string, unknown>): { value: Record<string, unknown>, normalizations: InputNormalization[] } {
    const changes = new Map<string, string>()
    const visit = (input: any, pointer: string, path: string, depth = 0): any => {
      if (depth > 64 || this.validator(pointer)(input)) return input
      const schema = this.resolve(pointer)
      if (!schema || typeof schema !== 'object') return input
      if (schema.$ref?.startsWith('#/')) return visit(input, schema.$ref.slice(1), path, depth + 1)
      let next = input
      if (typeof input === 'string') {
        next = input.trim()
        // PEM schemas may explicitly constrain their newline representation.
        if (schema.contentMediaType === 'application/x-pem-file') next = next.replaceAll('\r\n', '\n')
        if (schema.format && credentialFormats[schema.format]?.normalize !== 'none') {
          const normalize = credentialFormats[schema.format]?.normalize
          if (typeof normalize === 'function') next = normalize(next)
        }
      } else if (input && typeof input === 'object') {
        next = structuredClone(input)
        for (const [name] of Object.entries(schema.properties ?? {})) {
          if (!Object.hasOwn(next, name)) continue
          const escaped = name.replaceAll('~', '~0').replaceAll('/', '~1')
          next[name] = visit(next[name], `${pointer}/properties/${escaped}`, path ? `${path}.${name}` : name, depth + 1)
        }
        if (Array.isArray(next) && schema.items && !Array.isArray(schema.items)) {
          next = next.map((item, index) => visit(item, `${pointer}/items`, `${path}.${index}`, depth + 1))
        }
      }
      for (const [index] of (schema.allOf ?? []).entries()) next = visit(next, `${pointer}/allOf/${index}`, path, depth + 1)
      if (schema.if) {
        const branch = this.validator(`${pointer}/if`)(next) ? 'then' : 'else'
        if (schema[branch]) next = visit(next, `${pointer}/${branch}`, path, depth + 1)
      }
      // Alternative branches cannot choose an enum or credential identity for
      // the caller. Accept only a unique normalized result that validates.
      for (const keyword of ['oneOf', 'anyOf']) {
        if (!schema[keyword] || schema[keyword].some((_: Schema, index: number) => this.validator(`${pointer}/${keyword}/${index}`)(next))) continue
        const candidates = schema[keyword].map((_: Schema, index: number) => visit(next, `${pointer}/${keyword}/${index}`, path, depth + 1))
          .filter((candidate: unknown, index: number) => this.validator(`${pointer}/${keyword}/${index}`)(candidate))
        const unique = new Map(candidates.map((candidate: unknown) => [JSON.stringify(candidate), candidate]))
        if (unique.size === 1) next = [...unique.values()][0]
      }
      if (typeof input === 'string' && next !== input && this.validator(pointer)(next)) {
        changes.set(path, next === input.trim() ? 'removed surrounding whitespace' : 'canonicalized format')
        return next
      }
      return typeof input === 'string' ? input : next
    }
    const normalized = visit(value, '', '') as Record<string, unknown>
    // Reports derive from the final value, never speculative alternative branches.
    const normalizations = [...changes].filter(([path]) => {
      const read = (root: any) => path.split('.').reduce((node, key) => node?.[key], root)
      return read(value) !== read(normalized)
    }).map(([field, reason]) => ({ field, reason }))
    return { value: normalized, normalizations }
  }

  reasons(): { path: string[], message: string }[] {
    const errors = this.validate.errors ?? []
    const fieldsIn = (schema: Schema, path: string[]): string[] => {
      const names = new Set<string>([...schema?.required ?? [], ...Object.keys(schema?.properties ?? {})])
      const fields = [...names].flatMap(name => {
        const nested = fieldsIn(schema?.properties?.[name], [...path, name])
        return nested.length ? nested : [[...path, name].join('.')]
      })
      return [...fields, ...['allOf', 'oneOf', 'anyOf'].flatMap(keyword =>
        (schema?.[keyword] ?? []).flatMap((branch: Schema) => fieldsIn(branch, path)))]
    }
    const reason = (error: ErrorObject) => {
      const path = error.instancePath.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))
      const schema = this.resolve(error.schemaPath.replace(/^.*?#/, '').replace(/\/[^/]+$/, ''))
      if (error.keyword === 'required') path.push(error.params.missingProperty)
      if (error.keyword === 'additionalProperties') path.push(error.params.additionalProperty)
      let field = path.join('.') || 'credential'
      let rule = 'does not satisfy the credential rules'
      if (error.keyword === 'required') rule = 'is required'
      if (error.keyword === 'type') rule = `must be ${schema?.type ?? 'the expected type'}`
      if (error.keyword === 'format') rule = credentialFormats[error.params.format]?.reason ?? `must match the ${error.params.format} format`
      if (error.keyword === 'pattern' || error.keyword === 'not') rule = 'does not satisfy the allowed character or field combination rules'
      if (error.keyword === 'minLength') rule = 'must not be empty'
      if (error.keyword === 'enum' || error.keyword === 'const') rule = 'must match an allowed choice'
      if (error.keyword === 'not' && schema?.not?.pattern === '\\s') rule = 'must not contain whitespace'
      if (error.keyword === 'not') {
        const fields = [...new Set(fieldsIn(schema?.not, path))]
        if (fields.length) {
          field = fields.join(', ')
          rule = 'must not be used in this field combination'
        }
      }
      if (error.keyword === 'const' && typeof schema?.const === 'boolean') rule = `must be ${schema.const} for this URL`
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(error.keyword)) {
        rule = `must be ${error.params.comparison} ${error.params.limit}`
      }
      if (error.keyword === 'additionalProperties') rule = 'is an unsupported field'
      const branch = error.schemaPath.match(/^(.*?)\/(then|else)\//)
      if (branch && !(error.keyword === 'const' && typeof schema?.const === 'boolean')) {
        const condition = this.resolve(`${branch[1].replace(/^.*?#/, '')}/if`)
        const selectors = Object.keys(condition?.properties ?? {})
        if (selectors.length) rule += ` for the selected ${selectors.join(', ')}`
      }
      return { path, message: `${field} ${rule}.` }
    }
    const concrete = errors.filter(error => !['if', 'oneOf', 'anyOf'].includes(error.keyword)
      && !/\/(oneOf|anyOf)\//.test(error.schemaPath))
    const reasons = concrete.map(reason)
    const alternatives = errors.filter(error => ['oneOf', 'anyOf'].includes(error.keyword)
      || /\/(oneOf|anyOf)\//.test(error.schemaPath))
    if (!alternatives.length) return reasons
    // Conflicting alternatives name only schema-owned fields, never values.
    const fields = [...new Set(alternatives.flatMap(error => {
      const node = this.resolve(error.schemaPath.replace(/^.*?#/, '').replace(/\/[^/]+$/, ''))
      return [...Object.keys(node?.properties ?? {}), ...node?.required ?? []]
    }))]
    return [...reasons, { path: [], message: `${fields.join(', ') || 'credential'} must satisfy the selected credential field combination.` }]
  }
}
