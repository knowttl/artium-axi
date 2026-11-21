import { useRef, useState } from 'react'
import type { z } from 'zod'
import type { githubDeviceRoutes } from '../shared/api.js'
import { requestReauth } from './reauth.js'
import type { Report } from './submit.js'

export type GithubDeviceStart = z.infer<typeof githubDeviceRoutes.start.response>

export interface GithubDevice {
  connection: GithubDeviceStart
  status: string
  cancellable: boolean
}

const cancelUnconfirmed = 'Cancellation could not be confirmed. Reload to check the credential.'

export function useGithubDevice(action: string, csrf: string) {
  const [device, setDevice] = useState<GithubDevice | null>(null)
  const cancelConnection = useRef(() => {})
  const connect = async (connection: GithubDeviceStart, report: Report) => {
    const setStatus = (status: string) => setDevice(current => current && { ...current, status })
    const send = async (step: 'poll' | 'cancel') => {
      const request = () => fetch(`${action}/${step}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ connectionId: connection.connectionId, _csrf: csrf }) })
      let response = await request()
      if (response.status === 401 && (await response.clone().json() as { error?: { code?: string } }).error?.code === 'REAUTH_REQUIRED') {
        if (await requestReauth(csrf)) response = await request()
      }
      return response
    }
    let cancelled = false
    let cancellation: Promise<void> | undefined
    let release: (() => void) | undefined
    cancelConnection.current = () => {
      if (cancelled) return
      cancelled = true
      cancellation = send('cancel')
        .then(response => setStatus(response.ok ? 'Connection cancelled. The saved credential is unchanged.' : cancelUnconfirmed))
        .catch(() => setStatus(cancelUnconfirmed))
      release?.()
    }
    const countdown = () => {
      if (cancelled) return
      const remaining = Math.max(0, Math.ceil((connection.expiresAt - Date.now()) / 1000))
      setStatus(remaining ? `Waiting for GitHub approval. Code expires in ${remaining} seconds.` : 'Code expired. Start a new connection.')
    }
    setDevice({ connection, status: '', cancellable: true })
    countdown()
    const timer = setInterval(countdown, 1000)
    try {
      let interval = connection.interval
      while (Date.now() < connection.expiresAt) {
        await new Promise<void>(resolve => {
          const wait = setTimeout(resolve, interval * 1000)
          release = () => { clearTimeout(wait); resolve() }
        })
        release = undefined
        if (cancelled || Date.now() >= connection.expiresAt) break
        const response = await send('poll')
        if (cancelled) break
        if (response.redirected) {
          location.assign(response.url)
          return
        }
        const result = await response.json() as { status: string, interval: number, error: { message: string, next: string, code: string } }
        if (cancelled) break
        if (!response.ok) {
          setStatus('Connection stopped. Start a new connection after following the error below.')
          report(`${result.error.message} ${result.error.next} (${result.error.code})`, result.error.code === 'REVISION_CONFLICT')
          return
        }
        if (result.status === 'connected') {
          location.reload()
          return
        }
        interval = result.interval
      }
      if (cancelled) await cancellation
      else setStatus('Code expired. Start a new connection.')
    } finally {
      clearInterval(timer)
      setDevice(current => current && { ...current, cancellable: false })
    }
  }
  return { device, connect, cancel: () => cancelConnection.current() }
}
