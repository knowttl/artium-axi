import { escape } from '../escape.js'
import { icon, type IconName } from './ui.js'

// The status vocabulary from docs/design-system.md: one word per state, and only this module renders them.
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral'
interface State { word: string, tone: Tone, icon?: IconName }

const vocabulary = {
  healthy: { word: 'Healthy', tone: 'ok' },
  failing: { word: 'Failing', tone: 'err' },
  notSetUp: { word: 'Not set up', tone: 'neutral' },
  needsCredential: { word: 'Needs credential', tone: 'warn' },
  readyToTest: { word: 'Ready to test', tone: 'neutral' },
  readOnly: { word: 'Read-only', tone: 'neutral', icon: 'eye' },
  alwaysReadOnly: { word: 'Always read-only', tone: 'neutral', icon: 'lock' },
  writesOn: { word: 'Writes on', tone: 'warn', icon: 'zap' },
} as const satisfies Record<string, State>
export type StatusName = keyof typeof vocabulary

export function badge(name: StatusName): string {
  const state: State = vocabulary[name]
  const mark = state.icon ? icon(state.icon) : `<span class="dot ${state.tone}" aria-hidden="true"></span>`
  return `<span class="badge ${state.tone}">${mark}${escape(state.word)}</span>`
}

// The quieter inline form, for dense table cells.
export function status(name: StatusName): string {
  const state: State = vocabulary[name]
  const mark = state.icon ? icon(state.icon) : `<span class="dot ${state.tone}" aria-hidden="true"></span>`
  return `<span class="status ${state.tone}">${mark}${escape(state.word)}</span>`
}

// Operation counts are part of the word, so this one state takes a number.
function operationsOn(count: number, form: 'badge' | 'status'): string {
  return `<span class="${form} warn">${icon('zap')}${count} operation${count === 1 ? '' : 's'} on</span>`
}

// The next missing link of a tool's setup, then its health.
export function toolState(tool: { enabled: boolean, configured: boolean, health: { errorCode: string | null, checkedAt: number | null } }): StatusName {
  if (!tool.configured) return tool.enabled ? 'needsCredential' : 'notSetUp'
  if (tool.health.errorCode) return 'failing'
  if (tool.health.checkedAt !== null) return 'healthy'
  return 'readyToTest'
}

export function writes(tool: { capable: boolean, enabled: boolean, operations: number | null }, form: 'badge' | 'status'): string {
  const render = form === 'badge' ? badge : status
  if (!tool.capable) return render('alwaysReadOnly')
  if (!tool.enabled) return render('readOnly')
  return tool.operations === null ? render('writesOn') : operationsOn(tool.operations, form)
}
