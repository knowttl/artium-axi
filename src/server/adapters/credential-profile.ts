import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats, { type FormatName } from 'ajv-formats'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import { toolCredentialSchemaPaths } from '../config.js'
import type { ToolName } from '../store/credential-store.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter, PreparedCall } from './types.js'
import { toolAllowsWrites } from '../../shared/api.js'
import { CredentialInput, credentialFormats, standardCredentialFormats } from './credential-input.js'
export { isCanonicalHttpsOrigin } from './credential-input.js'

type Schema = Record<string, any>
export interface ProfileField { name: string, schema: Schema, required: boolean }

export function withCredentialProfile<Credential>(adapter: Adapter<Credential>, source: SecretSource,
  writeLog: string, profile: CredentialProfile | undefined,
  argumentsForCall: (args: readonly string[], input?: RunnerInput) => Pick<PreparedCall, 'args' | 'fileArguments' | 'invocation'>,
  limits: PreparedCall['limits'] = { timeoutMs: adapter.timeoutMs }): Adapter<unknown> {
  if (!profile) return adapter
  return { ...adapter, credentialSchema: profile.credentialSchema, credentialProfile: profile,
    async prepare(args, reference, input) {
      adapter.validateArgs(args, input)
      const normalized = argumentsForCall(args, input)
      if (reference.tool !== adapter.name) throw new ArtiumError('CREDENTIAL_INVALID')
      const value = await source.getCredential(reference)
      return { executable: adapter.executable, ...normalized,
        ...profile.prepare(adapter.name, value, writeLog, !toolAllowsWrites(adapter.name, value as Record<string, unknown>)), limits }
    } }
}

// Only the pinned package is consulted. Missing schemas retain the legacy adapter;
// invalid schemas fail startup rather than silently downgrading credential handling.
export function loadCredentialProfile(tool: ToolName, file: string | undefined = toolCredentialSchemaPaths[tool]): CredentialProfile | undefined {
  if (file === undefined) return
  let content: string
  try { content = readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new ArtiumError('CREDENTIAL_INVALID') }
  try { return new CredentialProfile(JSON.parse(content), tool) }
  catch { throw new ArtiumError('CREDENTIAL_INVALID') }
}

// Host inputs contain secret values. The package schema describes SecretRefs.
// Keep every non-secret constraint and validate both sides of that conversion.
export class CredentialProfile {
  readonly credentialSchema: z.ZodType<Record<string, unknown>>
  readonly inputSchema: Schema
  private readonly secrets = new Set<string>()
  private readonly validateInput: ValidateFunction
  private readonly validateProfile: (value: unknown) => boolean
  private readonly input: CredentialInput

  constructor(readonly schema: Schema, tool?: ToolName) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Expected a profile schema')
    this.inputSchema = this.hostSchema(schema)
    if (tool === 'gh-axi') {
      this.inputSchema.properties.token.not = { pattern: '^(gho_|ghu_|ghs_|ghr_)' }
    }
    if (tool === 'checkpoint-axi') {
      this.inputSchema.required = ['region', 'clientId', 'clientSecret']
    }
    if (tool === 'mg-axi') {
      this.inputSchema.properties.enabledPacks = { ...this.inputSchema.properties.enabledPacks,
        items: { enum: ['entra', 'security', 'mail'] }, minItems: 1, maxItems: 3, contains: { const: 'entra' } }
    }
    if (tool === 'hybrid-axi') {
      this.inputSchema.required = ['apiKey']
      this.inputSchema.properties.apiKey = { ...this.inputSchema.properties.apiKey, pattern: '^[^;=,\\s\\p{Cc}]+$', title: 'API key' }
    }
    if (tool === 'tenable-axi') {
      this.inputSchema.required = ['accessKey', 'secretKey']
      for (const name of ['accessKey', 'secretKey']) this.inputSchema.properties[name] = {
        ...this.inputSchema.properties[name], pattern: '^[^;=,\\s\\p{Cc}]+$',
      }
    }
    if (tool === 'awx-axi') {
      // A usable credential still requires origin plus token. Password sign-in is host-only input.
      this.inputSchema.required = ['origin']
      this.inputSchema.properties.origin = { type: 'string', format: 'canonical-https-origin', title: 'Controller origin' }
      this.inputSchema.properties.token = { ...this.inputSchema.properties.token, title: 'Personal access token',
        description: 'Paste an existing personal access token. Leave blank to keep the stored token.' }
      this.inputSchema.properties.signIn = { type: 'string', enum: ['token', 'password'], title: 'Sign-in',
        description: 'Choose password to sign in with a username and password. Artium mints one personal access token and stores only that token. Choose token, or leave this blank, to paste or keep a token.' }
      this.inputSchema.properties.username = { type: 'string', minLength: 1, title: 'Username',
        description: 'Controller username. Used once to mint a token and not stored.' }
      this.inputSchema.properties.password = { type: 'string', minLength: 1, pattern: '\\S', 'x-secret': true, 'x-ephemeral': true,
        title: 'Password', description: 'Controller password. Used once to mint a token, then discarded. It is not stored or logged.' }
      delete this.inputSchema.properties.verifySsl
      delete this.inputSchema.properties.allowHttp
      delete this.inputSchema.if
      delete this.inputSchema.else
      this.inputSchema.properties.allowWrites = { type: 'boolean', title: 'Allow operational writes' }
      this.inputSchema.allOf = [...this.inputSchema.allOf ?? [], {
        if: { required: ['signIn'], properties: { signIn: { const: 'password' } } },
        then: { required: ['username', 'password'], not: { anyOf: [{ required: ['token'] }] } },
        else: { required: ['token'], not: { anyOf: [{ required: ['username'] }, { required: ['password'] }] } },
      }]
    }
    if (tool === 'falcon-axi') {
      this.inputSchema.properties.allowWrites = { type: 'boolean', title: 'Allow RTR execution' }
      this.inputSchema.properties.writes = { type: 'object', additionalProperties: false, required: ['allowWrites', 'operations'],
        properties: { allowWrites: { type: 'boolean' }, operations: { type: 'array', minItems: 1, maxItems: 2,
          items: { enum: ['rtr run', 'malquery search'] } } } }
    }
    if (tool === 'ldap-axi') {
      this.inputSchema.required = [...new Set([...this.inputSchema.required ?? [], 'auth', 'bindDn', 'bindPassword'])]
      this.inputSchema.properties.auth = { const: 'simple', title: 'Authentication' }
      this.inputSchema.properties.url = { ...this.inputSchema.properties.url, format: 'ldap-url' }
      this.inputSchema.properties.caFile = { type: 'string', minLength: 1, description: 'Trusted CA PEM contents, not a server file path' }
      delete this.inputSchema.properties.gssapiService
      delete this.inputSchema.properties.gssapiProtection
      delete this.inputSchema.properties.flavor
      this.inputSchema.allOf = [...this.inputSchema.allOf ?? [], {
        if: { properties: { url: { pattern: '^ldap://' } } },
        then: { required: ['startTls'], properties: { startTls: { const: true } } },
      }, {
        if: { properties: { url: { pattern: '^ldaps://' } } },
        then: { properties: { startTls: { const: false } } },
      }]
    }
    if (tool === 'vectra-axi' && this.inputSchema.properties?.origin) {
      const origin = this.inputSchema.properties.origin
      this.inputSchema.properties.origin = { ...origin,
        allOf: [...(origin.allOf ?? []), { format: 'canonical-https-origin' }] }
    }
    for (const [selector, kind, field] of [['auth', 'token', 'token'], ['auth', 'oauth', 'clientSecret'],
      ['auth', 'client-secret', 'clientSecret'], ['auth', 'certificate', 'privateKey'],
      ['auth', 'federated', 'token'], ['mode', 'delegated', 'token']]) {
      if (schema.properties?.[field]?.['x-secret'] !== true) continue
      this.inputSchema.allOf = [...(this.inputSchema.allOf ?? []), {
        if: { required: [selector], properties: { [selector]: { const: kind } } },
        then: { required: [field], ...(selector === 'auth' && kind === 'token'
          ? { properties: { [field]: { not: { pattern: '\\s' } } } } : {}) },
      }]
    }
    const options = { strict: false, validateFormats: true, allErrors: true }
    const create = () => {
      const ajv = String(schema.$schema).includes('2020-12') ? new Ajv2020(options) : new Ajv(options)
      addFormats.default(ajv, { formats: Object.keys(standardCredentialFormats) as FormatName[] })
      for (const [name, format] of Object.entries(credentialFormats)) ajv.addFormat(name, { type: 'string', validate: format.validate })
      return ajv
    }
    const host = create()
    host.addKeyword({ keyword: 'x-secret', schemaType: 'boolean', errors: false,
      validate: (secret: boolean, value: unknown, _schema: unknown, context?: { instancePath: string }) => {
        if (secret && typeof value === 'string' && context) this.secrets.add(context.instancePath)
        return true
      } })
    this.input = new CredentialInput(this.inputSchema, host)
    this.validateInput = this.input.validate
    this.validateProfile = create().compile(schema)
    this.credentialSchema = z.custom<Record<string, unknown>>(value => {
      return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    }, 'Invalid credential profile').superRefine((value, context) => {
      this.secrets.clear()
      if (this.validateInput(value)) return
      for (const issue of this.input.reasons(value)) context.addIssue({ code: 'custom', ...issue })
    })
  }

  normalizeInput(value: Record<string, unknown>) {
    return this.input.normalize(value)
  }

  parseInput(value: Record<string, unknown>) {
    const normalized = this.normalizeInput(value)
    const result = this.credentialSchema.safeParse(normalized.value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT', result.error.issues.map(issue => issue.message).join(' '))
    return { value: result.data, normalizations: normalized.normalizations }
  }

  private hostSchema(schema: Schema, secretProperties: Schema = schema?.properties ?? {}): Schema {
    if (typeof schema !== 'object' || schema === null) return schema
    if (schema['x-secret'] === true) return { type: 'string', minLength: 1, pattern: '\\S',
      'x-secret': true, title: schema.title, description: schema.description }
    const result = { ...schema }
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
      if (schema[key]) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, value]) => {
        if (Array.isArray(value)) return [name, value]
        const field = key === 'properties' && secretProperties[name]?.['x-secret'] === true
          ? { ...(value as Schema), 'x-secret': true } : value as Schema
        const inherited = ['dependentSchemas', 'dependencies'].includes(key)
          ? { ...field?.properties, ...secretProperties } : undefined
        return [name, this.hostSchema(field, inherited)]
      }))
    }
    for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
      if (schema[key]) result[key] = schema[key].map((value: Schema) => this.hostSchema(value,
        key === 'prefixItems' ? value?.properties ?? {} : { ...value.properties, ...secretProperties }))
    }
    for (const key of ['items', 'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) {
      if (schema[key] !== undefined) result[key] = Array.isArray(schema[key])
        ? schema[key].map((value: Schema) => this.hostSchema(value)) : this.hostSchema(schema[key],
          ['not', 'if', 'then', 'else'].includes(key) ? { ...schema[key]?.properties, ...secretProperties } : schema[key]?.properties ?? {})
    }
    return result
  }

  private parsed(value: unknown) {
    const parsed = this.credentialSchema.safeParse(value)
    if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
    return { value: structuredClone(parsed.data), paths: [...this.secrets] }
  }

  private location(value: Record<string, unknown>, pointer: string) {
    const keys = pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))
    const key = keys.pop()!
    let parent: any = value
    for (const part of keys) parent = parent[part]
    return { parent, key }
  }

  metadata(value: unknown): Record<string, unknown> {
    const parsed = this.credentialSchema.safeParse(value)
    if (!parsed.success) return {}
    const metadata = structuredClone(parsed.data)
    for (const path of this.secrets) {
      const { parent, key } = this.location(metadata, path)
      delete parent[key]
    }
    return metadata
  }

  prepare(tool: ToolName, value: unknown, writeLog: string | undefined, readOnly: boolean): Pick<PreparedCall, 'environment' | 'files' | 'secrets'> {
    if (tool !== 'ldap-axi' && tool !== 'awx-axi' && (!writeLog || !isAbsolute(writeLog))) throw new TypeError('Native write log path must be absolute')
    const parsed = this.parsed(value)
    // These administrator switches are host policy, not upstream profile fields.
    if (tool === 'falcon-axi' || tool === 'awx-axi') delete parsed.value.allowWrites
    if (tool === 'falcon-axi') delete parsed.value.writes
    const environment: Record<string, string> = {}
    const secrets: string[] = []
    for (const path of parsed.paths) {
      const { parent, key } = this.location(parsed.value, path)
      const name = `ARTIUM_SECRET_${secrets.length}`
      const secret = parent[key] as string
      secrets.push(secret)
      environment[name] = secret
      parent[key] = { env: name }
    }
    if (!this.validateProfile(parsed.value)) throw new ArtiumError('CREDENTIAL_INVALID')
    if (tool !== 'ldap-axi') {
      const prefix = tool.toUpperCase().replaceAll('-', '_')
      environment[`${prefix}_READ_ONLY`] = String(readOnly)
      if (tool !== 'awx-axi') environment[`${prefix}_WRITE_LOG`] = writeLog!
    }
    // Vectra's CA bundle is a file path upstream; the host stores its PEM contents.
    const files: PreparedCall['files'] = []
    if (tool === 'vectra-axi' && typeof parsed.value.caBundle === 'string') {
      files.push({ name: 'vectra-axi/vectra-ca.pem', content: parsed.value.caBundle, appendTrustedCa: true })
      parsed.value.caBundle = 'vectra-ca.pem'
    }
    if (tool === 'ldap-axi') {
      files.push({ name: 'ldap-axi/ldap-ca.pem', content: typeof parsed.value.caFile === 'string' ? parsed.value.caFile : '', appendTrustedCa: true })
      parsed.value.caFile = 'ldap-axi/ldap-ca.pem'
    }
    return { environment, secrets, files: [...files, { name: `${tool}/config.json`, content: JSON.stringify({
      version: 1, defaultProfile: 'artium', profiles: { artium: parsed.value },
    }) }] }
  }

  // The editor shows all possible fields. Conditional requirements remain owned
  // by the full schema, which is also available beside the blank form.
  fields(): ProfileField[] {
    const fields = new Map<string, ProfileField>()
    const seen = new Set<Schema>()
    const visit = (schema: Schema) => {
      if (!schema || typeof schema !== 'object' || seen.has(schema)) return
      seen.add(schema)
      if (schema.$ref?.startsWith('#/')) {
        const target = schema.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], this.inputSchema)
        visit(target)
      }
      for (const [name, value] of Object.entries(schema.properties ?? {})) {
        const existing = fields.get(name)
        let field = value as Schema
        if (field.$ref?.startsWith('#/')) {
          const target = field.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], this.inputSchema)
          field = { ...target, ...field }
        }
        const choices = [...new Set([...(existing?.schema.enum ?? []), ...(field.enum ?? []),
          ...(Object.hasOwn(field, 'const') ? [field.const] : [])])]
        fields.set(name, { name, required: false, schema: { ...existing?.schema, ...field,
          ...(choices.length ? { enum: choices } : {}) } })
      }
      for (const key of ['allOf', 'oneOf', 'anyOf']) for (const branch of schema[key] ?? []) visit(branch)
      for (const key of ['then', 'else']) visit(schema[key])
    }
    visit(this.inputSchema)
    return [...fields.values()].map(field => ({ ...field, required: this.inputSchema.required?.includes(field.name) ?? false }))
  }
}
