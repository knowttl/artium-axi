import { AppShell } from '@astryxdesign/core/AppShell'
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs'
import { HStack } from '@astryxdesign/core/HStack'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TopNav } from '@astryxdesign/core/TopNav'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'

export interface FrameProps {
  title: string
  description?: string
  crumbs: { label: string, href?: string }[]
  brand: string
  navigation: string
  topbarEnd: string
}

export function Frame({ title, description, crumbs, brand, navigation, topbarEnd, actions, children }: FrameProps & { actions?: ReactNode, children: ReactNode }) {
  return (
    <AppShell variant="section" contentPadding={4}
      topNav={
        <TopNav label="Page header"
          startContent={
            <Breadcrumbs label="Breadcrumb">
              {crumbs.map((crumb, index) => <BreadcrumbItem key={index} href={crumb.href} isCurrent={index === crumbs.length - 1}>{crumb.label}</BreadcrumbItem>)}
            </Breadcrumbs>
          }
          endContent={<div data-frame-slot="header-end" dangerouslySetInnerHTML={{ __html: topbarEnd }} />} />
      }
      sideNav={
        <div className="frame-side">
          <div className="side-head" dangerouslySetInnerHTML={{ __html: brand }} />
          <div className="frame-nav" dangerouslySetInnerHTML={{ __html: navigation }} />
        </div>
      }>
      <VStack gap={4}>
        <HStack gap={4} justify="between" vAlign="start">
          <VStack gap={0.5}>
            <Heading level={1}>{title}</Heading>
            {description && <Text as="p" type="supporting">{description}</Text>}
          </VStack>
          {actions}
        </HStack>
        {children}
      </VStack>
    </AppShell>
  )
}
