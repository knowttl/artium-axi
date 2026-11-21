import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useRef, useState } from 'react'

export const createdTokenEvent = 'artium-created-token'

export function CreatedTokenDialog() {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const show = (event: Event) => {
      field.current!.value = (event as CustomEvent<string>).detail
      setOpen(true)
    }
    const clear = () => { field.current!.value = '' }
    document.addEventListener(createdTokenEvent, show)
    window.addEventListener('pagehide', clear)
    return () => {
      document.removeEventListener(createdTokenEvent, show)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  const done = () => {
    field.current!.value = ''
    setOpen(false)
    location.reload()
  }
  return (
    <Dialog id="created-token" isOpen={open} onOpenChange={next => { if (!next) done() }} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title="Copy your token now" />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text as="p">It will not be shown again.</Text>
              <label className="field">
                <span>Token</span>
                <input ref={field} className="input mono" readOnly autoComplete="off" onFocus={event => event.currentTarget.select()} data-autofocus="" />
              </label>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button type="button" label="Done" variant="secondary" onClick={done} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
