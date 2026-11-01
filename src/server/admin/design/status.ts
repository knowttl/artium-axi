import type { z } from 'zod'
import type { adminToolSchema, toolSchema } from '../../../shared/api.js'
import { escape } from '../escape.js'

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
  if (!tool.enabled) return { word: 'Disabled', tone: 'off' }
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

// Matches the audit query's failed-run rule; other non-success outcomes are error codes.
// Outcomes stay exact codes; only their tone is derived.
export function auditOutcome(record: { event: string, outcome: string, exit_code: number | null }): { word: string, tone: Tone } {
  if (record.event === 'run-terminal') {
    return record.outcome === 'completed' && record.exit_code === 0 ? { word: 'completed', tone: 'ok' }
      : { word: record.outcome === 'completed' ? `completed · exit ${record.exit_code ?? 'unknown'}` : record.outcome, tone: 'err' }
  }
  if (record.outcome === 'success' || record.outcome === 'completed') return { word: record.outcome, tone: 'ok' }
  if (record.outcome === 'started') return { word: record.outcome, tone: 'neutral' }
  return { word: record.outcome, tone: 'err' }
}
