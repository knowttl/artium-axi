import { Button } from '@astryxdesign/core/Button'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { confirmationRouteFor } from '../shared/confirmation-routes.js'
import type { CertificateInspection } from './certificate-inspection.js'
import type { GithubDeviceStart } from './github-device.js'
import { HydrationGate } from './hydrated.js'
import { submitForm, type Report } from './submit.js'
import type { TestOutcome } from './test-outcome.js'
import { toastEvent, type ToastDetail } from './toasts.js'

export interface Confirmation {
  consequence: string
  title?: string
  action?: string
  typedName?: string
}

export interface ConfirmationTokens {
  issued: Record<string, string>
  mint?: (method: string, path: string, name: string) => string
}

export const ConfirmationTokenContext = createContext<ConfirmationTokens>({ issued: {} })

const FormDirtyContext = createContext(false)

export interface FormMessageState {
  text: string
  reload: boolean
}

const FormMessageContext = createContext<{ message: FormMessageState | null, area: RefObject<boolean> } | null>(null)

export function FormMessage() {
  const { message, area } = useContext(FormMessageContext)!
  useLayoutEffect(() => {
    area.current = true
    return () => { area.current = false }
  }, [area])
  return <MessageArea message={message} />
}

export function MessageArea({ message }: { message: FormMessageState | null }) {
  const element = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (message?.text) element.current!.focus() }, [message])
  return (
    <p ref={element} className="message" data-sheet-message="" role="alert" tabIndex={-1}>
      {message?.text}
      {message?.reload && <><br /><Button label="Reload latest" size="sm" variant="secondary" onClick={() => location.reload()} /></>}
    </p>
  )
}

export const useFormDirty = () => useContext(FormDirtyContext)

export function useTextDraft(initialValue: string) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, onChange] = useState(initialValue)
  useLayoutEffect(() => { onChange(ref.current!.value) }, [])
  return { ref, value, onChange }
}

const differsFromDefaults = (form: HTMLFormElement) =>
  Array.from(form.elements).some(field => field instanceof HTMLInputElement && field.type === 'checkbox' && field.checked !== field.defaultChecked)

export interface ActionFormProps {
  action: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  csrf: string
  confirmation?: Confirmation
  successUrl?: string
  successMessage?: string
  trackChanges?: boolean
  claimLink?: boolean
  createdToken?: boolean
  bodyFrom?: (fields: FormData) => Record<string, unknown>
  saveTool?: string
  retestUrl?: string
  showTest?: (outcome: TestOutcome) => void
  showInspection?: (inspection: CertificateInspection) => void
  showDevice?: (connection: GithubDeviceStart, report: Report) => Promise<void>
  onMessage?: (message: FormMessageState) => void
  className?: string
  attributes?: Record<string, string | boolean>
  children: ReactNode
}

export function ActionForm({ action, method, csrf, confirmation, successUrl, successMessage, trackChanges, claimLink, createdToken, bodyFrom, saveTool, retestUrl, showTest, showInspection, showDevice, onMessage, className, attributes, children }: ActionFormProps) {
  const tokens = useContext(ConfirmationTokenContext)
  const form = useRef<HTMLFormElement>(null)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<FormMessageState | null>(null)
  const area = useRef(false)
  useLayoutEffect(() => { if (trackChanges) setDirty(differsFromDefaults(form.current!)) }, [trackChanges])
  const route = confirmationRouteFor(method, action)
  if (Boolean(route) !== Boolean(confirmation) || route && (route.tier === 3) !== Boolean(confirmation?.typedName)) {
    throw new Error(`${method} ${action} and its confirmation disagree with the confirmation routes`)
  }
  const tokenKey = JSON.stringify([method, action, confirmation?.typedName ?? ''])
  const token = confirmation && (tokens.issued[tokenKey] ??= tokens.mint?.(method, action, confirmation.typedName ?? '') ?? '')
  const report = (text: string, reload = false) => {
    if (onMessage) onMessage({ text, reload })
    else if (area.current) setMessage({ text, reload })
    else document.dispatchEvent(new CustomEvent<ToastDetail>(toastEvent, { detail: { text, reload } }))
  }
  return (
    <form ref={form} className={className} data-api="" data-method={method} data-confirm={confirmation?.consequence} data-confirm-title={confirmation?.title}
      data-confirm-action={confirmation?.action} data-confirm-name={confirmation?.typedName} data-confirm-token={token || undefined}
      data-save-tool={saveTool} {...attributes} action={action} method="post"
      onSubmit={event => {
        event.preventDefault()
        event.stopPropagation()
        void submitForm({ form: event.currentTarget, submitter: (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null, action, method, confirmation,
          token: token || undefined, successUrl, successMessage, claimLink, createdToken, bodyFrom, saveTool, retestUrl, showTest, showInspection, showDevice, report })
      }}
      onInput={trackChanges ? event => setDirty(differsFromDefaults(event.currentTarget)) : undefined} onReset={trackChanges ? () => setDirty(false) : undefined}>
      <input type="hidden" name="_csrf" value={csrf} />
      {confirmation && route?.native && (
        <>
          <input type="hidden" name="_confirmTitle" value={confirmation.title ?? ''} />
          <input type="hidden" name="_confirmAction" value={confirmation.action ?? ''} />
          <input type="hidden" name="_confirmText" value={confirmation.consequence} />
        </>
      )}
      <HydrationGate allowBeforeHydration={Boolean(route?.native)}>
        <FormMessageContext value={{ message, area }}><FormDirtyContext value={dirty}>{children}</FormDirtyContext></FormMessageContext>
      </HydrationGate>
    </form>
  )
}

export function Revision({ value }: { value: number }) {
  return <input type="hidden" name="expectedRevision" data-type="number" value={value} />
}
