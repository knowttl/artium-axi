import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useState } from 'react'

export const confirmationEvent = 'artium-confirm'

export interface ConfirmationRequest {
  title: string
  consequence: string
  action: string
  typedName: string
  resolve: (typedName: string | null) => void
}

// The confirmation tiers for the page script's forms: tier 2 shows the consequence, tier 3 also needs the exact name typed.
export function Confirmation() {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null)
  const [shown, setShown] = useState<ConfirmationRequest | null>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const open = (event: Event) => {
      event.preventDefault()
      const next = (event as CustomEvent<ConfirmationRequest>).detail
      setTyped('')
      setShown(next)
      setRequest(next)
    }
    document.addEventListener(confirmationEvent, open)
    return () => document.removeEventListener(confirmationEvent, open)
  }, [])
  const answer = (confirmed: boolean) => {
    request?.resolve(confirmed ? typed : null)
    setRequest(null)
  }
  const name = shown?.typedName ?? ''
  return (
    <Dialog id="confirmation" isOpen={request !== null} onOpenChange={open => { if (!open) answer(false) }} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={shown?.title ?? ''} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text as="p" id="confirmation-consequence" data-consequence="">{shown?.consequence}</Text>
              {name && <TextInput id="confirmation-name" label={`Type ${name} to confirm`} value={typed} onChange={setTyped} hasAutoFocus
                autoComplete="off" hasSpellCheck={false} {...{ 'data-confirm-name-input': '' }} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button type="button" value="cancel" label="Cancel" variant="ghost" onClick={() => answer(false)} {...name ? {} : { 'data-autofocus': '' }} />
              <Button type="button" value="confirmed" label={shown?.action ?? 'Confirm'} variant={name ? 'destructive' : 'primary'}
                isDisabled={Boolean(name) && typed !== name} onClick={() => { if (typed === name) answer(true) }} data-confirm-button="" />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
