import { Button } from '@astryxdesign/core/Button'
import { useToast } from '@astryxdesign/core/Toast'
import { useEffect, useRef, type ReactNode } from 'react'

export const toastEvent = 'artium-toast'
export const successKey = 'artium-toast'
const errorId = 'form-error'

export interface ToastDetail {
  text: string
  reload?: boolean
}

// Shows what the page script reports: a success saved before a reload, and an error from a form with no message area of its own.
export function Toasts({ children }: { children: ReactNode }) {
  const toast = useToast()
  const dismissError = useRef(() => {})
  useEffect(() => {
    const saved = sessionStorage.getItem(successKey)
    if (saved) {
      sessionStorage.removeItem(successKey)
      toast({ body: saved, isAutoHide: true, autoHideDuration: 6000 })
    }
    const report = (event: Event) => {
      dismissError.current()
      const { text, reload } = (event as CustomEvent<ToastDetail>).detail
      if (!text) return
      dismissError.current = toast({ type: 'error', body: text, uniqueID: errorId,
        endContent: reload ? <Button label="Reload latest" size="sm" variant="secondary" onClick={() => location.reload()} /> : undefined })
    }
    document.addEventListener(toastEvent, report)
    return () => document.removeEventListener(toastEvent, report)
  }, [toast])
  return children
}
