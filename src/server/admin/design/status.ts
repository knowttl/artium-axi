import { escape } from '../escape.js'

// Authoritative status labels and tones; render through badge() or status().
type Dot = 'ok' | 'warn' | 'err' | 'info' | 'off'
const states = {
  'provider-enabled': { word: 'Enabled', dot: 'ok' },
  'provider-disabled': { word: 'Disabled', dot: 'off' },
  'needs-credential': { word: 'Needs credential', dot: 'warn', pill: 'warn' },
  'credential-saved': { word: 'Saved', dot: 'ok' },
  'tool-available': { word: 'Available', dot: 'ok' },
  'tool-off': { word: 'Turned off by admin', dot: 'off' },
  'session-current': { word: 'Current', pill: 'ok' },
  'sign-in-password': { word: 'Password' },
  'sign-in-sso': { word: 'SSO', pill: 'info' },
  'sign-in-break-glass': { word: 'Break-glass', pill: 'warn' },
  administrator: { word: 'Admin', pill: 'solid' },
} satisfies Record<string, { word: string, dot?: Dot, pill?: 'ok' | 'warn' | 'err' | 'info' | 'solid' }>
export type State = keyof typeof states

function parts(state: State) {
  const value: { word: string, dot?: Dot, pill?: string } = states[state]
  return { word: value.word, pill: value.pill, dot: value.dot ? `<span class="dot ${value.dot}" aria-hidden="true"></span>` : '' }
}

export function badge(state: State): string {
  const { word, pill, dot } = parts(state)
  return `<span class="badge${pill ? ' ' + pill : ''}">${dot}${word}</span>`
}

// Product display names and their two-letter icons, keyed by tool package.
const tools: Record<string, [string, string]> = {
  'falcon-axi': ['CrowdStrike Falcon', 'FA'], 'vectra-axi': ['Vectra', 'VE'], 'az-axi': ['Azure', 'AZ'], 'mg-axi': ['Microsoft Graph', 'MG'],
  'ldap-axi': ['LDAP', 'LD'], 'ado-axi': ['Azure DevOps', 'AD'], 'gh-axi': ['GitHub', 'GH'], 'awx-axi': ['AWX', 'AW'],
  'tenable-axi': ['Tenable One', 'TE'], 'hybrid-axi': ['Hybrid Analysis', 'HA'], 'checkpoint-axi': ['Check Point Email', 'CP'],
  'beyondtrust-axi': ['BeyondTrust PM Cloud', 'BT'],
}
export function toolName(tool: string): string {
  return tools[tool]?.[0] ?? tool
}
export function toolIcon(tool: string): string {
  return `<span class="tool-ico" aria-hidden="true">${escape(tools[tool]?.[1] ?? tool.slice(0, 2).toUpperCase())}</span>`
}

// A dot and word without a pill, for dense rows.
export function status(state: State): string {
  const { word, dot } = parts(state)
  return `<span class="status">${dot}${word}</span>`
}
