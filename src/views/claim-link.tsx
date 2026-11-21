import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useState } from 'react'
import { useCopy } from './copy.js'
import { Icon } from './icon.js'

export const claimLinkEvent = 'artium-claim-link'

export function ClaimLinkDialog() {
  const [link, setLink] = useState<string | null>(null)
  const { source, status, copy } = useCopy<HTMLInputElement>()
  useEffect(() => {
    const open = (event: Event) => setLink((event as CustomEvent<string>).detail)
    document.addEventListener(claimLinkEvent, open)
    return () => document.removeEventListener(claimLinkEvent, open)
  }, [])
  const done = () => {
    setLink(null)
    location.reload()
  }
  return (
    <Dialog id="invitation-link" isOpen={link !== null} onOpenChange={open => { if (!open) done() }} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title="Copy the invitation link now" />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text as="p">This link is shown once. Send it to the person over a channel you trust. Their provider must be enabled before they can claim it.</Text>
              <div className="copy-group">
                <div className="copyfield">
                  <input ref={source} className="input" value={link ?? ''} readOnly aria-label="Invitation link" onFocus={event => event.currentTarget.select()}
                    data-autofocus="" />
                  <Button type="button" label="Copy" variant="primary" icon={<Icon name="copy" />} onClick={copy} />
                </div>
                <p className="copy-status" role="status">{status}</p>
              </div>
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
