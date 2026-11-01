import type { z } from 'zod'
import type { toolSchema } from '../../../shared/api.js'
import { escape } from '../escape.js'
import { icon } from './ui.js'

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'solid' | 'off'

// The authoritative status vocabulary: one word and tone per state, rendered only here.
const vocabulary = {
  health: { healthy: ['Healthy', 'ok'], failing: ['Failing', 'err'], unchecked: ['Not checked', 'neutral'] },
  setup: { 'needs-credential': ['Needs credential', 'warn'] },
  person: { enabled: ['Enabled', 'ok'], disabled: ['Disabled', 'off'], archived: ['Archived', 'neutral'], locked: ['Locked', 'warn'] },
  invitation: { pending: ['Pending', 'info'], expired: ['Expired', 'neutral'], claimed: ['Claimed', 'ok'], revoked: ['Revoked', 'neutral'] },
  grant: { direct: ['Direct', 'neutral'], rule: ['SSO rule', 'info'] },
  access: { yes: ['Yes', 'ok'], 'tool-disabled': ['No, tool disabled', 'off'], 'person-disabled': ['No, person disabled', 'off'] },
  signIn: { password: ['Password', 'neutral'], sso: ['SSO', 'info'], 'break-glass': ['Break-glass', 'warn'], admin: ['Admin', 'solid'] },
} as const satisfies Record<string, Record<string, readonly [string, Tone]>>

type Vocabulary = typeof vocabulary
export type StatusDomain = keyof Vocabulary

export function statusWord<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D]): string {
  return (vocabulary[domain][state] as readonly [string, Tone])[0]
}

// A pill badge; the word always carries the state and the dot is decorative.
export function badge<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D], dot = false): string {
  const [word, tone] = vocabulary[domain][state] as readonly [string, Tone]
  return `<span class="badge ${tone}">${dot ? `<span class="dot ${tone}" aria-hidden="true"></span>` : ''}${escape(word)}</span>`
}

// An inline dot and word, for table cells.
export function status<D extends StatusDomain>(domain: D, state: keyof Vocabulary[D]): string {
  const [word, tone] = vocabulary[domain][state] as readonly [string, Tone]
  return `<span class="status"><span class="dot ${tone}" aria-hidden="true"></span>${escape(word)}</span>`
}

// Writes: Read-only, Always read-only, or how many operations are on.
export function writesStatus(tool: { readOnly: boolean, writeAccess: { capable: boolean, enabled: boolean, allowedOperations: string[] } }): string {
  if (tool.readOnly) return `<span class="status">${tool.writeAccess.capable ? 'Read-only' : `${icon('lock')}Always read-only`}</span>`
  const count = tool.writeAccess.enabled ? tool.writeAccess.allowedOperations.length : 0
  return `<span class="status"><span class="dot warn" aria-hidden="true"></span>${count ? `${count} operation${count === 1 ? '' : 's'} on` : 'Writes on'}</span>`
}

export function healthState(health: { status: string }): keyof Vocabulary['health'] {
  return health.status === 'ok' ? 'healthy' : health.status === 'error' ? 'failing' : 'unchecked'
}

type Tool = z.infer<typeof toolSchema>
// Product names shown to people; package names stay visible as the exact identifier.
export const toolNames: Record<Tool, { name: string, mark: string }> = {
  'falcon-axi': { name: 'CrowdStrike Falcon', mark: 'FA' },
  'vectra-axi': { name: 'Vectra', mark: 'VE' },
  'az-axi': { name: 'Azure', mark: 'AZ' },
  'mg-axi': { name: 'Microsoft Graph', mark: 'MG' },
  'ldap-axi': { name: 'LDAP', mark: 'LD' },
  'ado-axi': { name: 'Azure DevOps', mark: 'AD' },
  'awx-axi': { name: 'AWX', mark: 'AW' },
  'tenable-axi': { name: 'Tenable One', mark: 'TE' },
  'hybrid-axi': { name: 'Hybrid Analysis', mark: 'HA' },
  'checkpoint-axi': { name: 'Check Point Email', mark: 'CP' },
  'beyondtrust-axi': { name: 'BeyondTrust PM Cloud', mark: 'BT' },
  'gh-axi': { name: 'GitHub', mark: 'GH' },
}

export function toolIcon(tool: Tool): string {
  return `<span class="tool-ico" aria-hidden="true">${toolNames[tool].mark}</span>`
}
