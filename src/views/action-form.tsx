import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { confirmationRouteFor } from '../shared/confirmation-routes.js'

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

export const useFormDirty = () => useContext(FormDirtyContext)

const differsFromDefaults = (form: HTMLFormElement) =>
  Array.from(form.elements).some(field => field instanceof HTMLInputElement && (field.checked !== field.defaultChecked || field.value !== field.defaultValue))

export interface ActionFormProps {
  action: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  csrf: string
  confirmation?: Confirmation
  successUrl?: string
  successMessage?: string
  trackChanges?: boolean
  claimLink?: boolean
  saveTool?: string
  className?: string
  attributes?: Record<string, string | boolean>
  children: ReactNode
}

export function ActionForm({ action, method, csrf, confirmation, successUrl, successMessage, trackChanges, claimLink, saveTool, className, attributes, children }: ActionFormProps) {
  const tokens = useContext(ConfirmationTokenContext)
  const form = useRef<HTMLFormElement>(null)
  const [dirty, setDirty] = useState(false)
  useLayoutEffect(() => { if (trackChanges) setDirty(differsFromDefaults(form.current!)) }, [trackChanges])
  const route = confirmationRouteFor(method, action)
  if (Boolean(route) !== Boolean(confirmation) || route && (route.tier === 3) !== Boolean(confirmation?.typedName)) {
    throw new Error(`${method} ${action} and its confirmation disagree with the confirmation routes`)
  }
  const tokenKey = JSON.stringify([method, action, confirmation?.typedName ?? ''])
  const token = confirmation && (tokens.issued[tokenKey] ??= tokens.mint?.(method, action, confirmation.typedName ?? '') ?? '')
  return (
    <form ref={form} className={className} data-api="" data-method={method} data-confirm={confirmation?.consequence} data-confirm-title={confirmation?.title}
      data-confirm-action={confirmation?.action} data-confirm-name={confirmation?.typedName} data-confirm-token={token || undefined} data-success-url={successUrl} data-success-message={successMessage}
      data-track-changes={trackChanges ? '' : undefined} data-invitation-link={claimLink ? '' : undefined} data-save-tool={saveTool} {...attributes} action={action} method="post"
      onChange={trackChanges ? event => setDirty(differsFromDefaults(event.currentTarget)) : undefined} onReset={trackChanges ? () => setDirty(false) : undefined}>
      <input type="hidden" name="_csrf" value={csrf} />
      {confirmation && route?.native && (
        <>
          <input type="hidden" name="_confirmTitle" value={confirmation.title ?? ''} />
          <input type="hidden" name="_confirmAction" value={confirmation.action ?? ''} />
          <input type="hidden" name="_confirmText" value={confirmation.consequence} />
        </>
      )}
      <FormDirtyContext value={dirty}>{children}</FormDirtyContext>
    </form>
  )
}

export function Revision({ value }: { value: number }) {
  return <input type="hidden" name="expectedRevision" data-type="number" value={value} />
}
