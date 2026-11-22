import { AppShell } from '@astryxdesign/core/AppShell'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'
import { Icon, type IconName } from './icon.js'
import { ReauthPill, useReauthWindow, type ReauthState } from './reauth.js'
import { sheetTrigger } from './sheet.js'
import { ThemeSwitch, type ThemeSwitchProps } from './theme-switch.js'

export interface NavigationLink {
  href: string
  label: string
  icon: IconName
  current: boolean
}

export interface NavigationSection {
  title?: string
  links: NavigationLink[]
}

export interface AccountMenuProps {
  name: string
  initials: string
  method: string
  links: NavigationLink[]
  csrf: string
}

export interface HelpPanelProps {
  title: string
  paragraphs: string[]
}

export interface FrameAction {
  id?: string
  label: string
  href: string
  variant: 'primary' | 'secondary'
  icon: IconName
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
  account: AccountMenuProps
  reauth: ReauthState
  sso: boolean
  themeSwitch: ThemeSwitchProps
  help: HelpPanelProps
}

function NavigationLinks({ sections }: { sections: NavigationSection[] }) {
  return sections.map(({ title, links }, index) => {
    const items = links.map(link => <SideNavItem key={link.href} href={link.href} label={link.label} isSelected={link.current}
      icon={<Icon name={link.icon} />} />)
    return title ? <SideNavSection key={index} title={title}>{items}</SideNavSection> : <div key={index}>{items}</div>
  })
}

function AccountMenu({ name, initials, method, links, csrf, sso }: AccountMenuProps & { sso: boolean }) {
  return (
    <details className="account-menu up">
      <summary>
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span className="who"><span className="sr-only">Signed in as </span><strong>{name}</strong><span>{method}</span></span>
        <Icon name="chevd" />
      </summary>
      <div className="popover">
        {links.length > 0 && <>
          {links.map(link => <a key={link.href} href={link.href} aria-current={link.current ? 'page' : undefined}><Icon name={link.icon} />{link.label}</a>)}
          <hr />
        </>}
        <form method="post" action="/logout">
          <input type="hidden" name="_csrf" value={csrf} />
          {sso && <label className="check"><input type="checkbox" name="providerLogout" value="true" /> Also sign out of your identity provider</label>}
          <button type="submit" className="btn btn-ghost btn-sm"><Icon name="logout" />Sign out</button>
        </form>
      </div>
    </details>
  )
}

function HelpPanel({ title, paragraphs }: HelpPanelProps) {
  return (
    <details className="page-help learn">
      <summary className="btn btn-ghost btn-sm" aria-label="Learn"><Icon name="book" /><span className="label">Learn</span></summary>
      <div className="learn-panel">
        <h2>{`Help with ${title.toLowerCase()}`}</h2>
        {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
    </details>
  )
}

export function Frame({ title, description, actions, crumbs, brand, navigation, account, reauth, sso, themeSwitch, help, children }: FrameProps & { children: ReactNode }) {
  const pill = <ReauthPill minutes={useReauthWindow(reauth)} />
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
              <div className="frame-controls frame-controls-drawer">{pill}<div className="frame-theme"><ThemeSwitch {...themeSwitch} /></div></div>
              <div className="side-foot"><AccountMenu {...account} sso={sso} /></div>
            </div>
          </details>
        </nav>
        <ol className="crumbs">{crumbs.map((crumb, index) => <li key={index}>{index === crumbs.length - 1
          ? <strong aria-current="page">{crumb.label}</strong>
          : crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}</li>)}</ol>
        <div data-frame-slot="header-end">
          <div className="frame-controls frame-controls-header">{pill}<div className="frame-theme"><ThemeSwitch {...themeSwitch} /></div></div>
          <div><HelpPanel {...help} /></div>
        </div>
      </header>}
      sideNav={
        <SideNav className="frame-side" aria-label={label}
          header={<SideNavHeading heading={brand.name} headingHref={brand.href} icon={<span className="logo" aria-hidden="true">{brand.name[0]}</span>} />}
          footer={<div className="side-foot"><AccountMenu {...account} sso={sso} /></div>}>
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
