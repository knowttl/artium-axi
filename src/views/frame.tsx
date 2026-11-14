import { AppShell } from '@astryxdesign/core/AppShell'
import { HStack } from '@astryxdesign/core/HStack'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'

export interface NavigationSection {
  title?: string
  links: { href: string, label: string, icon: string, current: boolean }[]
}

export interface FrameProps {
  title: string
  description?: string
  crumbs: { label: string, href?: string }[]
  brand: { name: string, href: string }
  navigation: NavigationSection[]
  account: string
  topbarEnd: string
}

function NavigationLinks({ sections }: { sections: NavigationSection[] }) {
  return sections.map(({ title, links }, index) => {
    const items = links.map(link => <SideNavItem key={link.href} href={link.href} label={link.label} isSelected={link.current}
      icon={<svg className="i" aria-hidden="true"><use href={`#i-${link.icon}`} /></svg>} />)
    return title ? <SideNavSection key={index} title={title}>{items}</SideNavSection> : <div key={index}>{items}</div>
  })
}

export function Frame({ title, description, crumbs, brand, navigation, account, topbarEnd, actions, children }: FrameProps & { actions?: ReactNode, children: ReactNode }) {
  return (
    <AppShell variant="section" contentPadding={4}
      mobileNav={{ breakpoint: 'none' }}
      topNav={<header className="topbar frame-topbar" role="presentation">
        <nav className="frame-mobile-nav" aria-label="Administration">
          <details>
            <summary className="btn btn-ghost btn-sm" data-testid="mobile-nav-toggle">Navigation</summary>
            <div className="frame-mobile-menu">
              <NavigationLinks sections={navigation} />
              <div className="side-foot" dangerouslySetInnerHTML={{ __html: account }} />
            </div>
          </details>
        </nav>
        <ol className="crumbs">{crumbs.map((crumb, index) => <li key={index}>{index === crumbs.length - 1
          ? <strong aria-current="page">{crumb.label}</strong>
          : crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}</li>)}</ol>
        <div data-frame-slot="header-end" dangerouslySetInnerHTML={{ __html: topbarEnd }} />
      </header>}
      sideNav={
        <SideNav className="frame-side" aria-label="Administration"
          header={<SideNavHeading heading={brand.name} headingHref={brand.href} icon={<span className="logo" aria-hidden="true">{brand.name[0]}</span>} />}
          footer={<div className="side-foot" dangerouslySetInnerHTML={{ __html: account }} />}>
          <NavigationLinks sections={navigation} />
        </SideNav>
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
