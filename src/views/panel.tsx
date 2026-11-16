import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { HStack } from '@astryxdesign/core/HStack'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'

export function Panel({ title, description, link, actions, children }: { title: string, description?: ReactNode, link?: { href: string, label: string }, actions?: ReactNode, children?: ReactNode }) {
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
          <VStack gap={0.5}>
            <Heading level={2} accessibilityLevel={2}>{title}</Heading>
            {description && <Text type="supporting">{description}</Text>}
          </VStack>
          {link && <Button href={link.href} label={link.label} variant="ghost" size="sm" />}
          {actions}
        </HStack>
        {children}
      </VStack>
    </Card>
  )
}
