import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { diagnosticText } from '../shared/diagnostic.js'
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

export const testOutcomeKey = () => 'credential-test:' + location.pathname

const TestOutcomeContext = createContext<{ outcome: TestOutcome, show: (outcome: TestOutcome) => void }>({ outcome: { message: '' }, show: () => {} })

export function TestOutcomeProvider({ children }: { children: ReactNode }) {
  const [outcome, setOutcome] = useState<TestOutcome>({ message: '' })
  const show = (next: TestOutcome) => setOutcome(previous => ({ message: next.message, health: next.health ?? previous.health }))
  useEffect(() => {
    const saved = sessionStorage.getItem(testOutcomeKey())
    if (!saved) return
    sessionStorage.removeItem(testOutcomeKey())
    const { diagnosticVersion, message, health } = JSON.parse(saved) as { diagnosticVersion?: number, message: string, health?: TestHealth }
    setOutcome({ message: diagnosticVersion === 1 ? message : 'Details unavailable. Run Test connection again.', health })
  }, [])
  return <TestOutcomeContext value={{ outcome, show }}>{children}</TestOutcomeContext>
}

export const useTestOutcome = () => useContext(TestOutcomeContext)

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
