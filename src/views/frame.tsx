import { AppShell } from '@astryxdesign/core/AppShell'
import { HStack } from '@astryxdesign/core/HStack'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'

export interface FrameProps {
  title: string
  description?: string
  crumbs: { label: string, href?: string }[]
  brand: string
  navigation: string
  mobileNavigation: string
  topbarEnd: string
}

export function Frame({ title, description, crumbs, brand, navigation, mobileNavigation, topbarEnd, actions, children }: FrameProps & { actions?: ReactNode, children: ReactNode }) {
  return (
    <AppShell variant="section" contentPadding={4}
      mobileNav={{ breakpoint: 'none' }}
      topNav={<header className="topbar frame-topbar" role="presentation">
        <nav className="frame-mobile-nav" aria-label="Administration">
          <details>
            <summary className="btn btn-ghost btn-sm" data-testid="mobile-nav-toggle">Navigation</summary>
            <div className="frame-mobile-menu frame-nav" dangerouslySetInnerHTML={{ __html: mobileNavigation }} />
          </details>
        </nav>
        <ol className="crumbs">{crumbs.map((crumb, index) => <li key={index}>{index === crumbs.length - 1
          ? <strong aria-current="page">{crumb.label}</strong>
          : crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}</li>)}</ol>
        <div data-frame-slot="header-end" dangerouslySetInnerHTML={{ __html: topbarEnd }} />
      </header>}
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
