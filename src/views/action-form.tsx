import type { ReactNode } from 'react'

export interface Confirmation {
  consequence: string
  title: string
  action: string
  typedName?: string
  successUrl?: string
}

export interface ActionFormProps {
  action: string
  method: 'POST' | 'PUT' | 'PATCH'
  csrf: string
  confirmation: Confirmation
  className?: string
  children: ReactNode
}

export function ActionForm({ action, method, csrf, confirmation, className, children }: ActionFormProps) {
  const { consequence, title, action: verb, typedName, successUrl } = confirmation
  return (
    <form className={className} data-api="" data-method={method} data-confirm={consequence} data-confirm-title={title} data-confirm-action={verb}
      data-confirm-name={typedName} data-success-url={successUrl} action={action} method="post">
      <input type="hidden" name="_csrf" value={csrf} />
      {children}
    </form>
  )
}

export function Revision({ value }: { value: number }) {
  return <input type="hidden" name="expectedRevision" data-type="number" value={value} />
}
