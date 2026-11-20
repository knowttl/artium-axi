import { useRef, useState } from 'react'

export function useCopy<Source extends HTMLElement>() {
  const source = useRef<Source>(null)
  const [status, setStatus] = useState('')
  const copy = async () => {
    const element = source.current!
    try {
      await navigator.clipboard.writeText(element instanceof HTMLInputElement ? element.value : element.textContent ?? '')
      setStatus('Copied.')
    } catch {
      if (element instanceof HTMLInputElement) {
        element.focus()
        element.select()
      } else getSelection()?.selectAllChildren(element)
      setStatus('Copy unavailable. Copy the selected text manually.')
    }
  }
  return { source, status, copy }
}
