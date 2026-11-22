import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Heading, Text } from '@astryxdesign/core/Text'
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ActionForm, FormMessage } from './action-form.js'
import { useHydrated } from './hydrated.js'
import { Icon } from './icon.js'

const SheetClose = createContext<{ closeHref: string, close: () => void } | null>(null)
const openers = new WeakMap<HTMLDialogElement, HTMLElement>()
const sheetQuery = ['sheet'] as const

function showSheet(dialog: HTMLDialogElement) {
  if (dialog.open && !dialog.matches(':modal')) dialog.removeAttribute('open')
  dialog.showModal()
  dialog.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button')?.focus()
}

export const sheetTrigger = (sheet: string) => ({
  'data-sheet': sheet,
  onClick(event: MouseEvent<HTMLElement>) {
    const dialog = document.getElementById(sheet)
    if (!(dialog instanceof HTMLDialogElement)) return
    event.preventDefault()
    openers.set(dialog, event.currentTarget)
    event.currentTarget.closest('details')?.removeAttribute('open')
    showSheet(dialog)
  },
})

export function SheetCancel() {
  const sheet = useContext(SheetClose)
  if (!sheet) throw new Error('SheetCancel requires a SheetFrame')
  const { closeHref, close } = sheet
  return <Button href={closeHref} label="Cancel" variant="ghost" data-sheet-close="" onClick={event => { event.preventDefault(); close() }} />
}

export interface SheetProps {
  name: string
  open: boolean
  query?: readonly string[]
  returnFocusId?: string
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

export function SheetFrame({ name, open, query = sheetQuery, returnFocusId, closeHref, title, description, children }: Pick<SheetProps, 'name' | 'open' | 'query' | 'returnFocusId' | 'closeHref' | 'title' | 'description' | 'children'>) {
  const id = `sheet-${name}`
  const dialog = useRef<HTMLDialogElement>(null)
  const [modal, setModal] = useState(false)
  const hydrated = useHydrated()
  useEffect(() => {
    if (!open || !hydrated) return
    const url = new URL(location.href)
    for (const parameter of query) url.searchParams.delete(parameter)
    history.replaceState(null, '', url)
    showSheet(dialog.current!)
    setModal(true)
  }, [open, query, hydrated])
  const close = () => dialog.current!.close()
  const returnFocus = () => {
    const element = dialog.current!
    if (element.open) return
    const opener = openers.get(element) ?? (returnFocusId
      ? document.getElementById(returnFocusId)
      : document.querySelector<HTMLElement>(`[data-sheet="${CSS.escape(id)}"]`))
    openers.delete(element)
    const target = opener?.closest('details')?.querySelector<HTMLElement>(':scope > summary') ?? opener
    target?.focus()
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

export function Sheet({ name, open, query, returnFocusId, closeHref, title, description, submit, action, method = 'POST', csrf, consequence, confirmTitle, confirmAction, successUrl, successMessage, claimLink, saveTool, footLead, children }: SheetProps) {
  return (
    <SheetFrame name={name} open={open} query={query} returnFocusId={returnFocusId} closeHref={closeHref} title={title} description={description}>
      <ActionForm action={action} method={method} csrf={csrf} confirmation={consequence ? { consequence, title: confirmTitle ?? submit, action: confirmAction ?? submit } : undefined}
        successUrl={successUrl} successMessage={successMessage} claimLink={claimLink} saveTool={saveTool}>
        <div className="sheet-body">
          <FormMessage />
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
