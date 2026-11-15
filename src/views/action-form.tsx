import type { ReactNode } from 'react'

export interface Confirmation {
  consequence: string
  title?: string
  action?: string
  typedName?: string
}

export interface ActionFormProps {
  action: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  csrf: string
  confirmation?: Confirmation
  successUrl?: string
  successMessage?: string
  trackChanges?: boolean
  claimLink?: boolean
  className?: string
  children: ReactNode
}

export function ActionForm({ action, method, csrf, confirmation, successUrl, successMessage, trackChanges, claimLink, className, children }: ActionFormProps) {
  return (
    <form className={className} data-api="" data-method={method} data-confirm={confirmation?.consequence} data-confirm-title={confirmation?.title}
      data-confirm-action={confirmation?.action} data-confirm-name={confirmation?.typedName} data-success-url={successUrl} data-success-message={successMessage}
      data-track-changes={trackChanges ? '' : undefined} data-invitation-link={claimLink ? '' : undefined} action={action} method="post">
      <input type="hidden" name="_csrf" value={csrf} />
      {children}
    </form>
  )
}

export function Revision({ value }: { value: number }) {
  return <input type="hidden" name="expectedRevision" data-type="number" value={value} />
}
