import type { z } from 'zod'
import type { adminToolSchema, toolSchema } from '../../../shared/api.js'
import { escape } from '../escape.js'
import { icon } from './ui.js'

// The status vocabulary from docs/design-system.md: one word and tone per server state.
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off' | 'neutral'

// A word with a dot; the word carries the state and the dot is decorative. `detail` adds its consequence.
export function status(word: string, tone: Tone, detail?: string): string {
  return `<span class="status"><span class="dot ${tone}" aria-hidden="true"></span>${escape(word)}${detail ? `<span class="hint">· ${escape(detail)}</span>` : ''}</span>`
}

export function badge(word: string, tone: Tone = 'neutral'): string {
  return `<span class="badge ${tone}">${escape(word)}</span>`
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
  if (!tool.enabled || tool.health.status === 'disabled') return { word: 'Disabled', tone: 'off' }
  if (tool.health.status === 'checking') return { word: 'Checking', tone: 'info' }
  if (tool.health.status === 'ok') return { word: 'Healthy', tone: 'ok' }
  if (tool.health.status === 'error') return { word: 'Failing', tone: 'err' }
  if (tool.health.status === 'unconfigured') return { word: 'Needs credential', tone: 'warn' }
  return { word: 'Not checked', tone: 'neutral' }
}

export function personStatus(user: { enabled: boolean, archivedAt: number | null }): string {
  if (user.archivedAt !== null) return status('Archived', 'neutral')
  return user.enabled ? status('Enabled', 'ok') : status('Disabled', 'off')
}

export function grantOrigin(origin: string): string {
  return origin === 'direct' ? badge('Direct') : badge('SSO rule', 'info')
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

export function toolIcon(tool: ToolName, size: 'sm' | 'lg' = 'sm'): string {
  return `<span class="tool-ico${size === 'lg' ? ' lg' : ''}" aria-hidden="true">${toolProducts[tool].mark}</span>`
}

const setupStates = {
  healthy: { word: 'Healthy', tone: 'ok' },
  failing: { word: 'Failing', tone: 'err' },
  notSetUp: { word: 'Not set up', tone: 'neutral' },
  needsCredential: { word: 'Needs credential', tone: 'warn' },
  readyToTest: { word: 'Ready to test', tone: 'neutral' },
} as const satisfies Record<string, { word: string, tone: Tone }>
export type SetupState = keyof typeof setupStates

// The next missing link of a tool's setup, then its cached test outcome; that outcome applies whether or not the tool is enabled.
export function toolSetupState(tool: { enabled: boolean, configured: boolean, health: { errorCode: string | null, checkedAt: number | null } }): SetupState {
  if (!tool.configured) return tool.enabled ? 'needsCredential' : 'notSetUp'
  if (tool.health.errorCode) return 'failing'
  if (tool.health.checkedAt !== null) return 'healthy'
  return 'readyToTest'
}

export function setupBadge(name: SetupState): string {
  const state = setupStates[name]
  return `<span class="badge ${state.tone}"><span class="dot ${state.tone}" aria-hidden="true"></span>${state.word}</span>`
}

// Write capability as an icon and word; `operations` is the selected count, or null when the tool has no operation list.
export function writes(tool: { capable: boolean, enabled: boolean, operations: number | null }, form: 'badge' | 'status'): string {
  const render = (word: string, tone: 'neutral' | 'warn', mark: 'eye' | 'lock' | 'zap') => `<span class="${form} ${tone}">${icon(mark)}${word}</span>`
  if (!tool.capable) return render('Always read-only', 'neutral', 'lock')
  if (!tool.enabled) return render('Read-only', 'neutral', 'eye')
  if (tool.operations === null) return render('Writes on', 'warn', 'zap')
  return render(`${tool.operations} operation${tool.operations === 1 ? '' : 's'} on`, 'warn', 'zap')
}
