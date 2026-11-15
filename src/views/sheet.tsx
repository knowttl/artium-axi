import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Heading, Text } from '@astryxdesign/core/Text'
import type { ReactNode } from 'react'
import { ActionForm } from './action-form.js'
import { Icon } from './icon.js'

export interface SheetProps {
  name: string
  open: boolean
  closeHref: string
  title: string
  description: string
  submit: string
  action: string
  method?: 'POST' | 'PUT' | 'PATCH'
  csrf: string
  consequence?: string
  confirmTitle?: string
  confirmAction?: string
  successUrl?: string
  successMessage?: string
  claimLink?: boolean
  saveTool?: string
  footLead?: ReactNode
  children: ReactNode
}

export function Sheet({ name, open, closeHref, title, description, submit, action, method = 'POST', csrf, consequence, confirmTitle, confirmAction, successUrl, successMessage, claimLink, saveTool, footLead, children }: SheetProps) {
  const id = `sheet-${name}`
  return (
    <>
      {open && <a className="scrim" href={closeHref} tabIndex={-1} aria-hidden="true" data-sheet-scrim="" />}
      <dialog className="sheet" id={id} aria-labelledby={`${id}-title`} open={open}>
        <div className="sheet-head">
          <div className="grow">
            <Heading level={2} id={`${id}-title`}>{title}</Heading>
            <Text type="supporting">{description}</Text>
          </div>
          <IconButton href={closeHref} label="Close" icon={<Icon name="x" />} variant="ghost" size="sm" data-sheet-close="" />
        </div>
        <ActionForm action={action} method={method} csrf={csrf} confirmation={consequence ? { consequence, title: confirmTitle ?? submit, action: confirmAction ?? submit } : undefined}
          successUrl={successUrl} successMessage={successMessage} claimLink={claimLink} saveTool={saveTool}>
          <div className="sheet-body">
            <p className="message" data-sheet-message="" role="alert" tabIndex={-1} />
            {children}
          </div>
          <div className="sheet-foot">
            <Button href={closeHref} label="Cancel" variant="ghost" data-sheet-close="" />
            {footLead}
            <Button type="submit" label={submit} variant="primary" />
          </div>
        </ActionForm>
      </dialog>
    </>
  )
}
