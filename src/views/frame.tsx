import { AppShell } from '@astryxdesign/core/AppShell'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'
import { Icon } from './icon.js'
import { ReauthPill, useReauthWindow, type ReauthState } from './reauth.js'
import { sheetTrigger } from './sheet.js'

export interface NavigationSection {
  title?: string
  links: { href: string, label: string, icon: string, current: boolean }[]
}

export interface FrameAction {
  id?: string
  label: string
  href: string
  variant: 'primary' | 'secondary'
  icon: string
  sheet?: string
  disabled?: boolean
}

export interface FrameProps {
  title: string
  description?: string
  actions?: FrameAction[]
  crumbs: { label: string, href?: string }[]
  brand: { name: string, href: string }
  navigation: NavigationSection[]
  account: string
  reauth: ReauthState
  controls: string
  topbarEnd: string
}

function NavigationLinks({ sections }: { sections: NavigationSection[] }) {
  return sections.map(({ title, links }, index) => {
    const items = links.map(link => <SideNavItem key={link.href} href={link.href} label={link.label} isSelected={link.current}
      icon={<Icon name={link.icon} />} />)
    return title ? <SideNavSection key={index} title={title}>{items}</SideNavSection> : <div key={index}>{items}</div>
  })
}

export function Frame({ title, description, actions, crumbs, brand, navigation, account, reauth, controls, topbarEnd, children }: FrameProps & { children: ReactNode }) {
  const pill = <ReauthPill minutes={useReauthWindow(reauth)} sso={reauth.sso} />
  const label = navigation.length ? 'Administration' : 'Account'
  return (
    <AppShell variant="section" contentPadding={4}
      mobileNav={{ breakpoint: 'none' }}
      topNav={<header className="topbar frame-topbar" role="presentation">
        <nav className="frame-mobile-nav" aria-label={label}>
          <details>
            <summary className="btn btn-ghost btn-sm" data-testid="mobile-nav-toggle">{navigation.length ? 'Navigation' : 'Menu'}</summary>
            <div className="frame-mobile-menu">
              <NavigationLinks sections={navigation} />
              <div className="frame-controls frame-controls-drawer">{pill}<div className="frame-theme" dangerouslySetInnerHTML={{ __html: controls }} /></div>
              <div className="side-foot" dangerouslySetInnerHTML={{ __html: account }} />
            </div>
          </details>
        </nav>
        <ol className="crumbs">{crumbs.map((crumb, index) => <li key={index}>{index === crumbs.length - 1
          ? <strong aria-current="page">{crumb.label}</strong>
          : crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}</li>)}</ol>
        <div data-frame-slot="header-end">
          <div className="frame-controls frame-controls-header">{pill}<div className="frame-theme" dangerouslySetInnerHTML={{ __html: controls }} /></div>
          <div dangerouslySetInnerHTML={{ __html: topbarEnd }} />
        </div>
      </header>}
      sideNav={
        <SideNav className="frame-side" aria-label={label}
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
          {actions && <HStack gap={2} wrap="wrap">
            {actions.map(action => <Button key={action.href} href={action.href} isDisabled={action.disabled} label={action.label} variant={action.variant} icon={<Icon name={action.icon} />}
              {...action.sheet ? sheetTrigger(action.sheet) : { id: action.id }} />)}
          </HStack>}
        </HStack>
        {children}
      </VStack>
    </AppShell>
  )
}
