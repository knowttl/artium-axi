import type { z } from 'zod'
import type { adminToolSchema, toolSchema } from '../../../shared/api.js'
import { escape } from '../escape.js'
import { icon } from './ui.js'

// The authoritative status vocabulary: one word and tone per server state.
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off' | 'neutral' | 'solid'

const vocabulary = {
  health: { healthy: ['Healthy', 'ok'], failing: ['Failing', 'err'], unchecked: ['Not checked', 'neutral'], checking: ['Checking', 'info'], disabled: ['Disabled', 'off'], 'needs-credential': ['Needs credential', 'warn'] },
  person: { enabled: ['Enabled', 'ok'], disabled: ['Disabled', 'off'], archived: ['Archived', 'neutral'], locked: ['Locked', 'warn'] },
  invitation: { pending: ['Pending', 'info'], expired: ['Expired', 'neutral'], claimed: ['Claimed', 'ok'], revoked: ['Revoked', 'neutral'] },
  grant: { direct: ['Direct', 'neutral'], rule: ['SSO rule', 'info'] },
  access: { yes: ['Yes', 'ok'], 'tool-disabled': ['No, tool disabled', 'off'], 'person-disabled': ['No, person disabled', 'off'] },
  signIn: { password: ['Password', 'neutral'], sso: ['SSO', 'info'], 'break-glass': ['Break-glass', 'warn'], admin: ['Admin', 'solid'] },
} as const satisfies Record<string, Record<string, readonly [string, Tone]>>

type Vocabulary = typeof vocabulary
type StatusDomain = keyof Vocabulary

function describe<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D]): { word: string, tone: Tone } {
  const [word, tone] = vocabulary[domain][state] as readonly [string, Tone]
  return { word, tone }
}

export function statusWord<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D]): string {
  return describe(domain, state).word
}

// A word with a dot; the word carries the state and the dot is decorative. `detail` adds its consequence.
export function status(word: string, tone: Tone, detail?: string): string {
  return `<span class="status"><span class="dot ${tone}" aria-hidden="true"></span>${escape(word)}${detail ? `<span class="hint">· ${escape(detail)}</span>` : ''}</span>`
}

// A pill; `dot` adds the decorative state dot before the word.
export function badge(word: string, tone: Tone = 'neutral', dot = false): string {
  return `<span class="badge ${tone}">${dot ? `<span class="dot ${tone}" aria-hidden="true"></span>` : ''}${escape(word)}</span>`
}

export function stateBadge<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D], dot = false): string {
  const { word, tone } = describe(domain, state)
  return badge(word, tone, dot)
}

export function stateStatus<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D]): string {
  const { word, tone } = describe(domain, state)
  return status(word, tone)
}

// Writes: Read-only, Always read-only, or how many operations are on.
export function writesStatus(tool: { readOnly: boolean, writeAccess: { capable: boolean, enabled: boolean, allowedOperations: string[] } }): string {
  if (tool.readOnly) return `<span class="status">${tool.writeAccess.capable ? 'Read-only' : `${icon('lock')}Always read-only`}</span>`
  const count = tool.writeAccess.enabled ? tool.writeAccess.allowedOperations.length : 0
  return `<span class="status"><span class="dot warn" aria-hidden="true"></span>${count ? `${count} operation${count === 1 ? '' : 's'} on` : 'Writes on'}</span>`
}

type ToolName = z.infer<typeof toolSchema>

// Product display names and their two-letter marks, the one place tools are named for people.
export const toolProducts: Record<ToolName, { name: string, mark: string }> = {
  'falcon-axi': { name: 'CrowdStrike Falcon', mark: 'FA' },
  'vectra-axi': { name: 'Vectra', mark: 'VE' },
  'mg-axi': { name: 'Microsoft Graph', mark: 'MG' },
  'ldap-axi': { name: 'LDAP', mark: 'LD' },
  'az-axi': { name: 'Azure', mark: 'AZ' },
  'ado-axi': { name: 'Azure DevOps', mark: 'AD' },
  'awx-axi': { name: 'AWX', mark: 'AW' },
  'gh-axi': { name: 'GitHub', mark: 'GH' },
  'tenable-axi': { name: 'Tenable One', mark: 'TE' },
  'hybrid-axi': { name: 'Hybrid Analysis', mark: 'HA' },
  'checkpoint-axi': { name: 'Check Point Email', mark: 'CP' },
  'beyondtrust-axi': { name: 'BeyondTrust PM Cloud', mark: 'BT' },
}

// A disabled tool blocks every call first, so it outranks health.
export function toolState(tool: Pick<z.infer<typeof adminToolSchema>, 'enabled' | 'health'>): { word: string, tone: Tone } {
  if (!tool.enabled || tool.health.status === 'disabled') return describe('health', 'disabled')
  if (tool.health.status === 'checking') return describe('health', 'checking')
  if (tool.health.status === 'ok') return describe('health', 'healthy')
  if (tool.health.status === 'error') return describe('health', 'failing')
  if (tool.health.status === 'unconfigured') return describe('health', 'needs-credential')
  return describe('health', 'unchecked')
}

export function toolStatus(tool: Pick<z.infer<typeof adminToolSchema>, 'enabled' | 'health'>): string {
  const { word, tone } = toolState(tool)
  return status(word, tone)
}

export function personStatus(user: { enabled: boolean, archivedAt: number | null }): string {
  return stateStatus('person', user.archivedAt !== null ? 'archived' : user.enabled ? 'enabled' : 'disabled')
}

export function grantOrigin(origin: string): string {
  return stateBadge('grant', origin === 'direct' ? 'direct' : 'rule')
}

export function toolIcon(tool: ToolName): string {
  return `<span class="tool-ico" aria-hidden="true">${toolProducts[tool].mark}</span>`
}

// Outcomes stay exact codes; only their tone is derived.
export function auditOutcome(record: { event: string, outcome: string, exit_code: number | null }): { word: string, tone: Tone } {
  if (record.event === 'run-terminal') {
    return record.outcome === 'completed' && record.exit_code === 0 ? { word: 'completed', tone: 'ok' }
      : { word: record.outcome === 'completed' ? `completed · exit ${record.exit_code ?? 'unknown'}` : record.outcome, tone: 'err' }
  }
  if (record.event === 'ado-api') return { word: record.outcome, tone: record.outcome === 'allowed' ? 'ok' : 'err' }
  if (record.event === 'transfer') {
    const tone = record.outcome === 'ready' || record.outcome === 'delivery-completed' ? 'ok'
      : ['preview', 'deleted', 'expired'].includes(record.outcome) ? 'neutral' : 'err'
    return { word: record.outcome, tone }
  }
  if (record.outcome === 'success') return { word: record.outcome, tone: 'ok' }
  if (record.event === 'run-start') return { word: record.outcome, tone: 'neutral' }
  return { word: record.outcome, tone: 'err' }
}
