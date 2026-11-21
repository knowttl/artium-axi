import { useEffect, useState } from 'react'
import { Icon } from './icon.js'

const reauthEvent = 'artium-reauth'
export const reauthRequestEvent = 'artium-reauth-request'
export const reauthCompleteMessage = 'artium-reauth-complete'
const refreshMs = 30_000
const minuteMs = 60_000

export interface ReauthState {
  remainingMs: number
}

interface ReauthSample {
  remainingMs: number
  wallTime: number
  monotonicTime: number
}

export function announceReauth(remainingMs: number) {
  const sample: ReauthSample = { remainingMs, wallTime: Date.now(), monotonicTime: performance.now() }
  document.dispatchEvent(new CustomEvent(reauthEvent, { detail: sample }))
}

export function useReauthWindow({ remainingMs }: ReauthState) {
  const [remaining, setRemaining] = useState(remainingMs)
  useEffect(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    let sample: ReauthSample = {
      remainingMs, wallTime: performance.timeOrigin + navigation.responseStart, monotonicTime: navigation.responseStart,
    }
    const refresh = () => {
      const wallTime = Date.now()
      const monotonicTime = performance.now()
      const elapsed = Math.max(0, wallTime - sample.wallTime, monotonicTime - sample.monotonicTime)
      sample = { remainingMs: Math.max(0, sample.remainingMs - elapsed), wallTime, monotonicTime }
      setRemaining(sample.remainingMs)
    }
    const confirmed = (event: Event) => {
      sample = (event as CustomEvent<ReauthSample>).detail
      refresh()
    }
    refresh()
    const timer = setInterval(refresh, refreshMs)
    document.addEventListener(reauthEvent, confirmed)
    return () => {
      clearInterval(timer)
      document.removeEventListener(reauthEvent, confirmed)
    }
  }, [remainingMs])
  return Math.ceil(remaining / minuteMs)
}

export function ReauthPill({ minutes }: { minutes: number }) {
  return (
    <span className={`unlock ${minutes ? 'on' : 'off'}`}
      title="Changes need an identity confirmation in the last 15 minutes. You are asked to confirm when you save.">
      <Icon name={minutes ? 'unlock' : 'lock'} />
      <span>{minutes ? `Changes unlocked · ${minutes} min` : 'Changes locked'}</span>
    </span>
  )
}
