import { useEffect, useState } from 'react'
import { Icon } from './icon.js'

export const reauthEvent = 'artium-reauth'
export const reauthCompleteMessage = 'artium-reauth-complete'
const refreshMs = 30_000
const windowMs = 60_000

export interface ReauthState {
  until: number
  renderedAt: number
  sso: boolean
}

export function useReauthWindow({ until, renderedAt }: ReauthState) {
  const [state, setState] = useState({ until, now: renderedAt })
  useEffect(() => {
    const refresh = () => setState(current => ({ ...current, now: Date.now() }))
    const confirmed = (event: Event) => setState({ until: (event as CustomEvent<number>).detail, now: Date.now() })
    refresh()
    const timer = setInterval(refresh, refreshMs)
    document.addEventListener(reauthEvent, confirmed)
    return () => {
      clearInterval(timer)
      document.removeEventListener(reauthEvent, confirmed)
    }
  }, [])
  return { until: state.until, minutes: Math.max(0, Math.ceil((state.until - state.now) / windowMs)) }
}

export function ReauthPill({ until, minutes, sso }: { until: number, minutes: number, sso: boolean }) {
  return (
    <span className={`unlock ${minutes ? 'on' : 'off'}`} data-reauth-until={until} data-reauth-method={sso ? 'sso' : 'local'}
      title="Changes need an identity confirmation in the last 15 minutes. You are asked to confirm when you save.">
      <Icon name={minutes ? 'unlock' : 'lock'} />
      <span data-reauth-text="">{minutes ? `Changes unlocked · ${minutes} min` : 'Changes locked'}</span>
    </span>
  )
}

export function ReauthCompleteNotice() {
  useEffect(() => { window.opener?.postMessage(reauthCompleteMessage, location.origin) }, [])
  return null
}
