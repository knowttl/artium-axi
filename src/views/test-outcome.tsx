import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { diagnosticText, leavesCachedHealth } from '../shared/diagnostic.js'
import { errors } from '../shared/errors.js'

export interface TestHealth {
  status: string
  checkedAt: number | null
  errorCode: string | null
  diagnostic?: unknown
}

export interface TestOutcome {
  message: string
  health?: TestHealth
}

const testOutcomeKey = () => 'credential-test:' + location.pathname

export function storeTestOutcome(outcome: TestOutcome) {
  sessionStorage.setItem(testOutcomeKey(), JSON.stringify({ diagnosticVersion: 1, ...outcome }))
}

const TestOutcomeContext = createContext<{ outcome: TestOutcome, tlsFailed?: boolean, show: (outcome: TestOutcome) => void } | null>(null)

export function TestOutcomeProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<{ outcome: TestOutcome, tlsFailed?: boolean }>({ outcome: { message: '' } })
  const show = (next: TestOutcome) => setResult(previous => ({
    outcome: { message: next.message, health: next.health ?? previous.outcome.health },
    tlsFailed: next.health && !leavesCachedHealth(next.health.errorCode) && next.health.errorCode !== 'REVISION_CONFLICT'
      ? next.health.errorCode === 'UPSTREAM_TLS_FAILED' : previous.tlsFailed,
  }))
  useEffect(() => {
    const saved = sessionStorage.getItem(testOutcomeKey())
    if (!saved) return
    sessionStorage.removeItem(testOutcomeKey())
    const { diagnosticVersion, message, health } = JSON.parse(saved) as { diagnosticVersion?: number, message: string, health?: TestHealth }
    show({ message: diagnosticVersion === 1 ? message : 'Details unavailable. Run Test connection again.', health })
  }, [])
  return <TestOutcomeContext value={{ ...result, show }}>{children}</TestOutcomeContext>
}

export function useTestOutcome() {
  const context = useContext(TestOutcomeContext)
  if (!context) throw new Error('Test outcomes require TestOutcomeProvider')
  return context
}

export function TestResultNote() {
  return <p className="note" data-test-result="" role="status">{useTestOutcome().outcome.message}</p>
}

export function useTestHealth() {
  const { health } = useTestOutcome().outcome
  if (!health) return null
  const errorCode = health.errorCode !== null && Object.hasOwn(errors, health.errorCode) ? health.errorCode as keyof typeof errors : null
  return {
    passed: health.status === 'ok',
    errorCode,
    summary: errorCode ? `${errors[errorCode].message} ${errors[errorCode].next}` : '',
    diagnostic: diagnosticText(health.diagnostic),
    checkedAt: health.checkedAt === null ? null : new Date(health.checkedAt).toISOString(),
  }
}
