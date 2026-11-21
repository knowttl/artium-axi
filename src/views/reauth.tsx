import { useEffect, useState } from 'react'
import { Icon } from './icon.js'

const reauthEvent = 'artium-reauth'
const refreshMs = 30_000
const minuteMs = 60_000

export interface ReauthState {
  remainingMs: number
  sso: boolean
}

export function useReauthWindow({ remainingMs }: ReauthState) {
  const [remaining, setRemaining] = useState(remainingMs)
  useEffect(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    let expiresAt = navigation.responseStart + remainingMs
    const refresh = () => setRemaining(Math.max(0, expiresAt - performance.now()))
    const confirmed = (event: Event) => {
      expiresAt = (event as CustomEvent<number>).detail
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

export function ReauthPill({ minutes, sso }: { minutes: number, sso: boolean }) {
  return (
    <span className={`unlock ${minutes ? 'on' : 'off'}`} data-reauth-method={sso ? 'sso' : 'local'}
      title="Changes need an identity confirmation in the last 15 minutes. You are asked to confirm when you save.">
      <Icon name={minutes ? 'unlock' : 'lock'} />
      <span data-reauth-text="">{minutes ? `Changes unlocked · ${minutes} min` : 'Changes locked'}</span>
    </span>
  )
}
