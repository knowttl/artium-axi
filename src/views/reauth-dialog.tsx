import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './icon.js'
import { announceReauth, reauthCompleteMessage, reauthRequestEvent } from './reauth.js'

const popupPollMs = 500

export interface ReauthRequest {
  csrf: string
  resolve: (confirmed: boolean) => void
}

interface Attempt {
  controller: AbortController
  popup: Window | null
  popupWatch?: ReturnType<typeof setInterval>
}

// The identity confirmation for admin action forms: a password posted here, or a provider window for SSO. Cancel resolves false so the form keeps its draft.
export function ReauthDialog({ sso }: { sso: boolean }) {
  const [request, setRequest] = useState<ReauthRequest | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempt = useRef<Attempt | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const open = (event: Event) => {
      event.preventDefault()
      setPassword('')
      setError('')
      setBusy(false)
      setRequest((event as CustomEvent<ReauthRequest>).detail)
    }
    document.addEventListener(reauthRequestEvent, open)
    return () => document.removeEventListener(reauthRequestEvent, open)
  }, [])
  useEffect(() => {
    if (!request) return
    const current: Attempt = { controller: new AbortController(), popup: null }
    attempt.current = current
    const { signal } = current.controller
    const completed = async (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== current.popup || event.data !== reauthCompleteMessage || signal.aborted) return
      try {
        const response = await fetch('/reauth?status=1', { headers: { Accept: 'application/json' }, signal })
        if (!response.ok || response.redirected) throw new Error()
        const status = await response.json() as { sessionId: string, remainingMs: number }
        if (status.sessionId !== document.body.dataset.sessionId || !(status.remainingMs > 0)) throw new Error()
        if (signal.aborted) return
        announceReauth(status.remainingMs)
        request.resolve(true)
        setRequest(null)
      } catch {
        if (!signal.aborted) setError('Identity confirmation did not complete for this session. Try again or cancel to keep your draft.')
      }
    }
    window.addEventListener('message', completed)
    return () => {
      current.controller.abort()
      clearInterval(current.popupWatch)
      current.popup?.close()
      window.removeEventListener('message', completed)
      attempt.current = null
    }
  }, [request])
  const cancel = () => {
    setPassword('')
    request?.resolve(false)
    setRequest(null)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const current = attempt.current
    if (!request || !current || busy) return
    const { signal } = current.controller
    setBusy(true)
    setError('')
    if (sso) {
      current.popup = window.open('/reauth', 'artium-reauth', 'popup,width=600,height=760')
      if (!current.popup) {
        setError('Allow a popup for artium, then try again. Your draft stays here.')
        setBusy(false)
        return
      }
      const popup = current.popup
      current.popupWatch = setInterval(() => {
        if (!popup.closed) return
        clearInterval(current.popupWatch)
        setBusy(false)
        setError('Confirmation window closed. Try again or cancel to keep your draft.')
      }, popupPollMs)
      return
    }
    try {
      const response = await fetch('/v1/auth/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: request.csrf, password: new FormData(event.currentTarget).get('password') }), signal })
      if (signal.aborted) return
      setPassword('')
      if (response.redirected) {
        location.assign(response.url)
        cancel()
        return
      }
      if (!response.ok) {
        const { error: failure } = await response.json() as { error: { message: string, next: string, code: string } }
        setError(`${failure.message} ${failure.next} (${failure.code})`)
        passwordInput.current?.focus()
        return
      }
      announceReauth(Number(response.headers.get('x-artium-reauth-remaining-ms')))
      request.resolve(true)
      setRequest(null)
    } catch {
      if (!signal.aborted) setError('Password confirmation could not complete. Try again or cancel to keep your draft.')
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <Dialog id="reauth-dialog" isOpen={request !== null} onOpenChange={open => { if (!open) cancel() }} purpose="form" width={460}>
      <form onSubmit={submit}>
        <Layout
          header={<DialogHeader title={sso ? 'Confirm your identity' : 'Confirm it’s you'} />}
          content={
            <LayoutContent>
              <VStack gap={3}>
                <Text as="p">{`Sensitive changes need a confirmation every 15 minutes. ${sso ? 'Confirm with your provider in a new window.' : 'Enter your password.'} Cancel keeps your draft.`}</Text>
                {!sso && <TextInput ref={passwordInput} label="Password" htmlName="password" type="password" value={password} onChange={setPassword}
                  autoComplete="current-password" hasAutoFocus {...{ required: true }} />}
                {error && <Banner status="error" icon={<Icon name="alert" />} title={error} role="alert" {...{ 'data-reauth-error': '' }} />}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button type="button" label="Cancel" variant="ghost" onClick={cancel} {...{ 'data-reauth-cancel': '' }} />
                <Button type="submit" label="Confirm and continue" variant="primary" isDisabled={busy} {...sso ? { 'data-autofocus': '' } : {}} />
              </HStack>
            </LayoutFooter>
          }
        />
      </form>
    </Dialog>
  )
}
