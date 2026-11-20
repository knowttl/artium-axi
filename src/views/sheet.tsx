import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Heading, Text } from '@astryxdesign/core/Text'
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ActionForm } from './action-form.js'
import { Icon } from './icon.js'

const SheetClose = createContext({ closeHref: '', close: () => {} })

function showSheet(dialog: HTMLDialogElement) {
  if (dialog.open) dialog.close()
  dialog.showModal()
  dialog.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button')?.focus()
}

export const sheetTrigger = (sheet: string) => ({
  'data-sheet': sheet,
  onClick(event: MouseEvent<HTMLElement>) {
    const dialog = document.getElementById(sheet)
    if (!(dialog instanceof HTMLDialogElement)) return
    event.preventDefault()
    event.currentTarget.closest('details')?.removeAttribute('open')
    showSheet(dialog)
  },
})

export function SheetCancel() {
  const { closeHref, close } = useContext(SheetClose)
  return <Button href={closeHref} label="Cancel" variant="ghost" data-sheet-close="" onClick={event => { event.preventDefault(); close() }} />
}

export interface SheetProps {
  name: string
  open: boolean
  query?: string
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

export function SheetFrame({ name, open, query, closeHref, title, description, children }: Pick<SheetProps, 'name' | 'open' | 'query' | 'closeHref' | 'title' | 'description' | 'children'>) {
  const id = `sheet-${name}`
  const dialog = useRef<HTMLDialogElement>(null)
  const [modal, setModal] = useState(false)
  useEffect(() => {
    if (!open) return
    const url = new URL(location.href)
    url.searchParams.delete(query ?? 'sheet')
    history.replaceState(null, '', url)
    showSheet(dialog.current!)
    setModal(true)
  }, [open, query])
  const close = () => dialog.current!.close()
  const returnFocus = () => {
    if (dialog.current!.open) return
    const trigger = [...document.querySelectorAll<HTMLElement>('[data-sheet]')].find(link => link.dataset.sheet === id)
    ;(trigger?.closest('details')?.querySelector('summary') ?? trigger)?.focus()
  }
  return (
    <SheetClose value={{ closeHref, close }}>
      {open && <a className="scrim" href={closeHref} tabIndex={-1} aria-hidden="true" hidden={modal} data-sheet-scrim="" />}
      <dialog ref={dialog} className="sheet" id={id} aria-labelledby={`${id}-title`} open={open} onClose={returnFocus}>
        <div className="sheet-head">
          <div className="grow">
            <Heading level={2} id={`${id}-title`}>{title}</Heading>
            <Text type="supporting">{description}</Text>
          </div>
          <IconButton href={closeHref} label="Close" icon={<Icon name="x" />} variant="ghost" size="sm" data-sheet-close="" onClick={event => { event.preventDefault(); close() }} />
        </div>
        {children}
      </dialog>
    </SheetClose>
  )
}

export function Sheet({ name, open, query, closeHref, title, description, submit, action, method = 'POST', csrf, consequence, confirmTitle, confirmAction, successUrl, successMessage, claimLink, saveTool, footLead, children }: SheetProps) {
  return (
    <SheetFrame name={name} open={open} query={query} closeHref={closeHref} title={title} description={description}>
      <ActionForm action={action} method={method} csrf={csrf} confirmation={consequence ? { consequence, title: confirmTitle ?? submit, action: confirmAction ?? submit } : undefined}
        successUrl={successUrl} successMessage={successMessage} claimLink={claimLink} saveTool={saveTool}>
        <div className="sheet-body">
          <p className="message" data-sheet-message="" role="alert" tabIndex={-1} />
          {children}
        </div>
        <div className="sheet-foot">
          <SheetCancel />
          {footLead}
          <Button type="submit" label={submit} variant="primary" />
        </div>
      </ActionForm>
    </SheetFrame>
  )
}
