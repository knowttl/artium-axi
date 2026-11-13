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
import { toolAllowsWrites, falconWriteOperations, proxmoxWriteOperations, technitiumWriteOperations } from '../../shared/api.js'
import { CredentialInput, credentialFormats, standardCredentialFormats } from './credential-input.js'
import applicationMode from '../../shared/mg-application-mode.json' with { type: 'json' }
import { kubernetesSessionPolicy } from '../../shared/kubernetes.js'
import { shodanExportPolicy, shodanQueryPolicy, shodanScanPolicy, shodanStreamPolicy, shodanWritePolicy } from '../../shared/shodan-stream.js'
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
    if (tool === 'kubernetes-axi') {
      this.inputSchema.properties.allowWrites = { type: 'boolean', title: 'Allow Kubernetes mutation workflows' }
      this.inputSchema.properties.acquireCredential = { type: 'boolean', title: 'Allow private Kubernetes token acquisition' }
      this.inputSchema.properties.sessions = z.toJSONSchema(kubernetesSessionPolicy)
      this.inputSchema.properties.collectionDelete = { type: 'boolean', title: 'Allow Kubernetes bulk deletion',
        description: 'Requires Allow writes and native frozen-target confirmation. Off by default.' }
      this.inputSchema.properties.origin.format = 'canonical-https-origin'
      this.inputSchema.properties.certificateAuthority.description = 'Paste the cluster issuing CA PEM. Managed tokens and client certificates also support strict leaf pins for reads and mutation workflows. Hosted byte sessions require issuing CA trust.'
      this.inputSchema.properties.clientCertificate.description = 'Paste the client certificate PEM for certificate authentication. Changing it requires a new private key.'
    }
    if (tool === 'technitium-axi') {
      this.inputSchema.required = ['origin', 'auth', 'tokenKind', 'token']
      this.inputSchema.properties.origin.format = 'canonical-https-origin'
      this.inputSchema.properties.caFile = { type: 'string', minLength: 1, title: 'Trusted CA PEM', description: 'PEM certificate contents, not a file path.' }
      this.inputSchema.properties.writes.properties.operations.items.enum = technitiumWriteOperations
      this.inputSchema.properties.writes.properties.operations.maxItems = technitiumWriteOperations.length
      this.inputSchema.properties.hostWrites = { type: 'object', additionalProperties: false, required: ['allowWrites', 'operations'],
        properties: { allowWrites: { type: 'boolean' }, operations: { type: 'array', maxItems: technitiumWriteOperations.length,
          items: { type: 'string', enum: technitiumWriteOperations } } } }
    }
    if (tool === 'shodan-axi') {
      this.inputSchema.properties.sessions = z.toJSONSchema(shodanStreamPolicy)
      this.inputSchema.properties.scans = z.toJSONSchema(shodanScanPolicy)
      this.inputSchema.properties.writes = z.toJSONSchema(shodanWritePolicy)
      this.inputSchema.properties.exports = z.toJSONSchema(shodanExportPolicy)
      this.inputSchema.properties.queries = z.toJSONSchema(shodanQueryPolicy)
      this.inputSchema.required = ['auth', 'origin', 'apiKey']
      this.inputSchema.properties.auth = { const: 'api-key' }
      this.inputSchema.properties.origin = { type: 'string', const: 'https://api.shodan.io' }
      delete this.inputSchema.properties.streamOrigin
    }
    if (tool === 'gitea-axi') {
      delete this.inputSchema.properties.allowInsecureHttp
      delete this.inputSchema.if
      delete this.inputSchema.then
      for (const name of ['origin', 'tokenOrigin']) this.inputSchema.properties[name] = { type: 'string', format: 'canonical-https-origin' }
    }
    if (tool === 'unifi-axi' || tool === 'proxmox-axi') {
      this.inputSchema.properties.origin = { type: 'string', format: 'canonical-https-origin' }
      if (tool === 'unifi-axi') {
        this.inputSchema.required = ['origin', 'apiKey']
        delete this.inputSchema.properties.allowSecretExport
      } else {
        this.inputSchema.properties.writes.properties.operations.items.enum = proxmoxWriteOperations
        this.inputSchema.properties.writes.properties.operations.maxItems = proxmoxWriteOperations.length
        this.inputSchema.properties.hostWrites = { type: 'object', additionalProperties: false, required: ['allowWrites', 'operations'],
          properties: { allowWrites: { type: 'boolean' }, operations: { type: 'array', maxItems: proxmoxWriteOperations.length,
            items: { type: 'string', enum: proxmoxWriteOperations } } } }
        this.inputSchema.properties.auth = { enum: ['api-token', 'password'] }
        this.inputSchema.required = ['origin', 'auth']
        this.inputSchema.oneOf = [
          { ...this.inputSchema.oneOf[0], required: ['tokenId', 'token'] },
          { ...this.inputSchema.oneOf[2], required: ['userId', 'password'] },
        ]
        for (const name of ['ticket', 'csrfPreventionToken', 'otp']) delete this.inputSchema.properties[name]
        this.inputSchema.properties.caBundle.description = 'Trusted CA certificate PEM contents, materialized privately for each call. Do not enter a server file path.'
      }
    }
    if (tool === 'gh-axi') {
      this.inputSchema.properties.token.not = { pattern: '^(gho_|ghu_|ghs_|ghr_)' }
    }
    if (tool === 'beyondtrust-axi') {
      this.inputSchema.required = ['host', 'clientId', 'clientSecret']
      this.inputSchema.properties.clientSecret.description = 'Enter the API account client secret itself. Leave blank to keep a stored secret for the same identity.'
      this.inputSchema.properties.downloads.description = 'Artium manages download permissions. This value does not enable downloads. Use artium-axi download with Allow writes on and the exact download operation selected.'
      this.inputSchema.properties.writes.description = 'Use Allow writes and select exact operations to permit writes and managed downloads. Deletes also require Allow deletes. Writes and deletes are disabled by default.'
    }
    if (tool === 'checkpoint-axi') {
      this.inputSchema.required = ['region', 'clientId', 'clientSecret']
      this.inputSchema.properties.clientSecret.title = 'Client secret'
      this.inputSchema.properties.clientSecret.description = 'Enter the API client secret itself. Leave blank to keep a stored secret for the same identity.'
      this.inputSchema.properties.downloads.description = 'Artium manages download permissions. This value does not enable downloads. Use artium-axi download with Allow writes on and the exact download operation selected.'
      this.inputSchema.properties.scope.description = 'Download scope supplied by your tenant administrator or Check Point support. Use printable ASCII with no spaces (characters ! through ~); comma-separated values are sent verbatim. Email downloads require this value as the scopes header. Attachment downloads use it as the scope query when set, and omit that query when unset. Artium uses this stored value for hosted transfers; there is no per-download scope override. Tenant scope authorization and the relationship between these selectors remain unverified; do not guess a value.'
    }
    if (tool === 'mg-axi') {
      delete this.inputSchema.properties.rawWrites
      delete this.inputSchema.properties.rawBatch
      this.inputSchema.properties.sensitiveAreas = { type: 'array', maxItems: 0, default: [] }
      this.inputSchema.properties.writes.required = ['allowWrites', 'operations']
      this.inputSchema.properties.writes.properties.operations.minItems = 1
      this.inputSchema.properties.enabledPacks = { ...this.inputSchema.properties.enabledPacks,
        items: { enum: ['entra', 'security', 'mail'] }, minItems: 1, maxItems: 3, contains: { const: 'entra' } }
      this.inputSchema.allOf = [...this.inputSchema.allOf ?? [], {
        if: { required: ['enabledPacks'], properties: { enabledPacks: { contains: { const: 'mail' } } } },
        then: applicationMode,
      }]
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
      this.inputSchema.properties.allowWrites = { type: 'boolean', title: 'Allow AWX writes' }
      this.inputSchema.properties.allowDeletes = { type: 'boolean', title: 'Allow destructive deletes',
        description: 'Off by default. Deletes and bulk host operations also require Allow writes, --dry-run preview and --confirm.' }
      this.inputSchema.properties.allowSecurityAdministration = { type: 'boolean', title: 'Allow security administration',
        description: 'Off by default. Security administration also requires Allow writes, --dry-run preview and --confirm. Resource deletes additionally require Allow destructive deletes.' }
      this.inputSchema.properties.allowConfigurationWrites = { type: 'boolean', deprecated: true,
        description: 'Legacy setting, ignored. Only administrator allowWrites grants mutation access.' }
      this.inputSchema.allOf = [...this.inputSchema.allOf ?? [], {
        if: { required: ['signIn'], properties: { signIn: { const: 'password' } } },
        then: { required: ['username', 'password'], not: { anyOf: [{ required: ['token'] }] } },
        else: { required: ['token'], not: { anyOf: [{ required: ['username'] }, { required: ['password'] }] } },
      }]
    }
    if (tool === 'falcon-axi') {
      this.inputSchema.required = ['clientId', 'clientSecret', 'region']
      this.inputSchema.properties.allowWrites = { type: 'boolean', title: 'Allow RTR execution' }
      this.inputSchema.properties.writes = { type: 'object', additionalProperties: false, required: ['allowWrites', 'operations'],
        properties: { allowWrites: { type: 'boolean' }, operations: { type: 'array', minItems: 1, maxItems: falconWriteOperations.length,
          items: { enum: falconWriteOperations } } } }
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
      if (tool === 'gitea-axi' && value.origin !== value.tokenOrigin) context.addIssue({ code: 'custom', path: ['tokenOrigin'], message: 'tokenOrigin must match origin.' })
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

  prepare(tool: ToolName, value: unknown, writeLog: string | undefined, readOnly: boolean,
    hostFields: Record<string, unknown> = {}): Pick<PreparedCall, 'environment' | 'files' | 'secrets'> {
    if (!['ldap-axi', 'awx-axi', 'unifi-axi', 'proxmox-axi', 'technitium-axi', 'shodan-axi', 'gitea-axi', 'kubernetes-axi'].includes(tool) && (!writeLog || !isAbsolute(writeLog))) throw new TypeError('Native write log path must be absolute')
    const parsed = this.parsed(value)
    // These administrator switches are host policy, not upstream profile fields.
    if (tool === 'falcon-axi' || tool === 'awx-axi' || tool === 'kubernetes-axi') delete parsed.value.allowWrites
    if (tool === 'kubernetes-axi') delete parsed.value.collectionDelete
    if (tool === 'shodan-axi') delete parsed.value.sessions
    if (tool === 'shodan-axi') delete parsed.value.scans
    if (tool === 'shodan-axi') delete parsed.value.writes
    if (tool === 'shodan-axi') delete parsed.value.exports
    if (tool === 'shodan-axi') delete parsed.value.queries
    if (tool === 'kubernetes-axi') delete parsed.value.sessions
    if (tool === 'kubernetes-axi') delete parsed.value.acquireCredential
    if (tool === 'awx-axi') delete parsed.value.allowConfigurationWrites
    if (tool === 'awx-axi') delete parsed.value.allowDeletes
    if (tool === 'awx-axi') delete parsed.value.allowSecurityAdministration
    if (tool === 'falcon-axi') delete parsed.value.writes
    if (tool === 'proxmox-axi' || tool === 'technitium-axi') delete parsed.value.hostWrites
    Object.assign(parsed.value, hostFields)
    const environment: Record<string, string> = {}
    if (tool === 'beyondtrust-axi') environment.BEYONDTRUST_AXI_CONFIG = '/proc/self/cwd/beyondtrust-axi/config.json'
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
      if (writeLog) environment[`${prefix}_WRITE_LOG`] = writeLog
    }
    // Vectra's CA bundle is a file path upstream; the host stores its PEM contents.
    const files: PreparedCall['files'] = []
    if (tool === 'technitium-axi' && typeof parsed.value.caFile === 'string') {
      files.push({ name: 'technitium-axi/technitium-ca.pem', content: parsed.value.caFile, appendTrustedCa: true })
      parsed.value.caFile = 'technitium-ca.pem'
    }
    if (tool === 'proxmox-axi' && typeof parsed.value.caBundle === 'string') {
      files.push({ name: 'proxmox-axi/ca.pem', content: parsed.value.caBundle, appendTrustedCa: true })
      parsed.value.caBundle = '/proc/self/cwd/proxmox-axi/ca.pem'
    }
    if (tool === 'vectra-axi' && typeof parsed.value.caBundle === 'string') {
      files.push({ name: 'vectra-axi/vectra-ca.pem', content: parsed.value.caBundle, appendTrustedCa: true })
      parsed.value.caBundle = 'vectra-ca.pem'
    }
    if (tool === 'ldap-axi') {
      files.push({ name: 'ldap-axi/ldap-ca.pem', content: typeof parsed.value.caFile === 'string' ? parsed.value.caFile : '', appendTrustedCa: true })
      parsed.value.caFile = 'ldap-axi/ldap-ca.pem'
    }
    return { environment, secrets, files: [...files, { name: `${tool}/config.json`,
      ...(tool === 'kubernetes-axi' ? { appendTrustedCaAt: ['profiles', 'artium', 'certificateAuthority'] } : {}), content: JSON.stringify({
      version: 1, defaultProfile: 'artium', profiles: { artium: parsed.value },
    }) }] }
  }

  // Only the approved host broker may derive a per-call ticket profile from its selected password profile.
  proxmoxTicket(prepared: Pick<PreparedCall, 'environment' | 'files' | 'secrets'>, ticket: string, csrf: string): void {
    const file = prepared.files.find(file => file.name === 'proxmox-axi/config.json')!
    const configuration = JSON.parse(String(file.content))
    const profile = configuration.profiles.artium
    if (profile.auth !== 'password') throw new ArtiumError('CREDENTIAL_INVALID')
    const reference = profile.password
    profile.auth = 'ticket'
    profile.ticket = reference
    profile.csrfPreventionToken = { env: 'ARTIUM_SECRET_1' }
    delete profile.password
    if (!this.validateProfile(profile)) throw new ArtiumError('CREDENTIAL_INVALID')
    prepared.environment[reference.env] = ticket
    prepared.environment.ARTIUM_SECRET_1 = csrf
    prepared.secrets.push(ticket, csrf)
    file.content = JSON.stringify(configuration)
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
