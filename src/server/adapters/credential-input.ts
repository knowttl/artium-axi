import type { Ajv, ValidateFunction } from 'ajv'
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
    const changes = new Map<string, { path: string[], reason: string }>()
    const visit = (input: any, pointer: string, path: string[], depth = 0): any => {
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
          next[name] = visit(next[name], `${pointer}/properties/${escaped}`, [...path, name], depth + 1)
        }
        if (!Array.isArray(next) && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          for (const name of Object.keys(next)) {
            if (Object.hasOwn(schema.properties ?? {}, name)) continue
            next[name] = visit(next[name], `${pointer}/additionalProperties`, [...path, name], depth + 1)
          }
        }
        if (Array.isArray(next) && schema.items && !Array.isArray(schema.items)) {
          next = next.map((item, index) => visit(item, `${pointer}/items`, [...path, String(index)], depth + 1))
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
        changes.set(JSON.stringify(path), { path, reason: next === input.trim() ? 'removed surrounding whitespace' : 'canonicalized format' })
        return next
      }
      return typeof input === 'string' ? input : next
    }
    const normalized = visit(value, '', []) as Record<string, unknown>
    // Reports derive from the final value, never speculative alternative branches.
    const normalizations = [...changes.values()].filter(({ path }) => {
      const read = (root: any) => path.reduce((node, key) => node?.[key], root)
      return read(value) !== read(normalized)
    }).map(({ path, reason }) => ({ field: path.join('.'), reason }))
    return { value: normalized, normalizations }
  }

  reasons(value: Record<string, unknown>): { path: string[], message: string }[] {
    const reasons: { path: string[], message: string }[] = []
    const escape = (name: string) => name.replaceAll('~', '~0').replaceAll('/', '~1')
    const add = (path: string[], rule: string, field = path.join('.') || 'credential') => {
      reasons.push({ path, message: `${field} ${rule}.` })
    }
    // Read conflict names from the rules that actually matched the exclusion,
    // including referenced and nested alternatives, rather than all possible fields.
    const fieldsIn = (pointer: string, input: any, path: string[], depth = 0): string[] => {
      if (depth > 64) return []
      const schema = this.resolve(pointer)
      if (!schema || typeof schema !== 'object') return []
      const fields: string[] = []
      if (schema.$ref?.startsWith('#/')) fields.push(...fieldsIn(schema.$ref.slice(1), input, path, depth + 1))
      for (const name of new Set<string>([...schema.required ?? [], ...Object.keys(schema.properties ?? {})])) {
        if (!input || !Object.hasOwn(input, name)) continue
        const nested = schema.properties?.[name]
          ? fieldsIn(`${pointer}/properties/${escape(name)}`, input[name], [...path, name], depth + 1) : []
        fields.push(...nested.length ? nested : [[...path, name].join('.')])
      }
      for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
        for (const [index] of (schema[keyword] ?? []).entries()) {
          const child = `${pointer}/${keyword}/${index}`
          if (this.validator(child)(input)) fields.push(...fieldsIn(child, input, path, depth + 1))
        }
      }
      if (schema.not) fields.push(...fieldsIn(`${pointer}/not`, input, path, depth + 1))
      if (schema.if) {
        fields.push(...fieldsIn(`${pointer}/if`, input, path, depth + 1))
        const branch = this.validator(`${pointer}/if`)(input) ? 'then' : 'else'
        if (schema[branch]) fields.push(...fieldsIn(`${pointer}/${branch}`, input, path, depth + 1))
      }
      return [...new Set(fields)]
    }
    // Only constraints with different choices across branches select an identity.
    // A shared constraint (for example allowDeviceCode: false) is still reported
    // as an error in the selected branch, rather than disqualifying that branch.
    const selectorsIn = (pointer: string, path: string[] = [], depth = 0): Map<string, string> => {
      const selectors = new Map<string, string>()
      if (depth > 64) return selectors
      const schema = this.resolve(pointer)
      if (!schema || typeof schema !== 'object') return selectors
      for (const keyword of ['const', 'enum', 'type']) {
        if (schema[keyword] !== undefined) selectors.set(JSON.stringify([path, keyword]), JSON.stringify(schema[keyword]))
      }
      const merge = (child: string, childPath = path) => {
        for (const [key, rule] of selectorsIn(child, childPath, depth + 1)) selectors.set(key, rule)
      }
      if (schema.$ref?.startsWith('#/')) merge(schema.$ref.slice(1))
      for (const name of Object.keys(schema.properties ?? {})) merge(`${pointer}/properties/${escape(name)}`, [...path, name])
      for (const [index] of (schema.allOf ?? []).entries()) merge(`${pointer}/allOf/${index}`)
      return selectors
    }
    const visit = (pointer: string, input: any, path: string[], selected = false, condition = '', depth = 0): void => {
      const validate = this.validator(pointer)
      if (validate(input)) return
      if (depth > 64) { add(path, 'must satisfy the selected credential field combination'); return }
      const schema = this.resolve(pointer)
      const before = reasons.length
      // Capture local failures before child validators replace their error lists.
      // AJV remains the authority for keyword semantics (Unicode lengths, equality,
      // numeric bounds); the walker owns traversal and branch-specific reporting.
      const local = (validate.errors ?? []).filter(error => error.instancePath === ''
        && error.schemaPath.split('#').pop() === `${pointer}/${error.keyword}`)
      for (const error of local) {
        const { keyword, params } = error
        const target = [...path]
        if (keyword === 'required') target.push(params.missingProperty)
        if (keyword === 'additionalProperties') target.push(params.additionalProperty)
        let rule: string | undefined
        if (keyword === 'required') rule = 'is required'
        if (keyword === 'type') rule = `must be ${schema.type}`
        if (keyword === 'format') rule = credentialFormats[params.format]?.reason ?? `must match the ${params.format} format`
        if (keyword === 'pattern') rule = 'must match the required character pattern'
        if (keyword === 'minLength') rule = `must have a length >= ${params.limit}`
        if (keyword === 'maxLength') rule = `must have a length <= ${params.limit}`
        if (keyword === 'minItems') rule = `must contain at least ${params.limit} item${params.limit === 1 ? '' : 's'}`
        if (keyword === 'maxItems') rule = `must contain at most ${params.limit} item${params.limit === 1 ? '' : 's'}`
        if (keyword === 'uniqueItems') rule = 'must contain unique items'
        if (keyword === 'enum' || keyword === 'const') rule = 'must match an allowed choice'
        if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(keyword)) rule = `must be ${params.comparison} ${params.limit}`
        if (keyword === 'additionalProperties') rule = 'is an unsupported field'
        if (keyword === 'propertyNames') rule = 'must use property names that satisfy the schema'
        if (keyword === 'false schema') rule = 'is not permitted by the schema'
        if (keyword === 'not') {
          const fields = fieldsIn(`${pointer}/not`, input, path)
          if (fields.length) {
            add(path, selected ? 'must satisfy the selected credential field combination' : 'must not be used in this field combination', fields.join(', '))
            continue
          }
          rule = schema.not.pattern === '\\s' ? 'must not contain whitespace' : 'must not match the excluded rule'
        }
        if (rule) {
          if (condition) rule = keyword === 'const' && typeof schema.const === 'boolean'
            ? `must be ${schema.const} ${condition === 'url' ? 'for this URL' : `for the selected ${condition}`}`
            : `${rule} for the selected ${condition}`
          add(target, rule)
        }
      }
      if (schema.$ref?.startsWith('#/')) visit(schema.$ref.slice(1), input, path, selected, condition, depth + 1)
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        for (const name of Object.keys(input)) {
          const child = Object.hasOwn(schema.properties ?? {}, name) ? `properties/${escape(name)}`
            : typeof schema.additionalProperties === 'object' ? 'additionalProperties' : undefined
          if (child) visit(`${pointer}/${child}`, input[name], [...path, name], selected, condition, depth + 1)
        }
      }
      if (Array.isArray(input) && schema.items && !Array.isArray(schema.items)) {
        input.forEach((item, index) => visit(`${pointer}/items`, item, [...path, String(index)], selected, condition, depth + 1))
      }
      for (const [index] of (schema.allOf ?? []).entries()) visit(`${pointer}/allOf/${index}`, input, path, selected, condition, depth + 1)
      if (schema.if) {
        const branch = this.validator(`${pointer}/if`)(input) ? 'then' : 'else'
        if (schema[branch]) visit(`${pointer}/${branch}`, input, path, selected, Object.keys(schema.if.properties ?? {}).join(', '), depth + 1)
      }
      for (const keyword of ['oneOf', 'anyOf']) {
        if (!schema[keyword]) continue
        const branches = schema[keyword].map((_: Schema, index: number) => `${pointer}/${keyword}/${index}`) as string[]
        const passing = branches.filter(child => this.validator(child)(input))
        if (passing.length === 1 || (keyword === 'anyOf' && passing.length)) continue
        const selectors = branches.map(child => selectorsIn(child))
        const choices = new Map<string, Set<string>>()
        for (const branch of selectors) for (const [key, rule] of branch) {
          if (!choices.has(key)) choices.set(key, new Set())
          choices.get(key)!.add(rule)
        }
        const candidates = branches.filter((_, index) => [...selectors[index]].every(([key, rule]) => {
          if (choices.get(key)!.size < 2) return true
          const [parts, keyword] = JSON.parse(key) as [string[], string]
          const value = parts.reduce((node, name) => node?.[name], input)
          if (value === undefined) return true
          return this.ajv.validate({ [keyword]: JSON.parse(rule) }, value)
        }))
        if (!passing.length && candidates.length === 1) visit(candidates[0], input, path, true, condition, depth + 1)
        else add(path, 'must satisfy the selected credential field combination')
      }
      // Diagnostics must never turn a validator rejection into accepted input,
      // including when a future profile introduces a new schema keyword.
      if (reasons.length === before) add(path, 'must satisfy the credential schema')
    }
    visit('', value, [])
    return reasons.filter((reason, index) => reasons.findIndex(other => JSON.stringify(other) === JSON.stringify(reason)) === index)
  }
}
