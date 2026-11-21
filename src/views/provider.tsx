import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'
import { ActionForm, ActionSubmit, Revision } from './action-form.js'
import { useCopy } from './copy.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { ProviderCredential, type ProviderCredentialProps } from './provider-credential.js'
import { ProviderFields } from './provider-fields.js'
import { RoleRules, type RoleRulesProps } from './role-rules.js'
import { Tabs, type TabLink } from './tabs.js'
import { LastChange } from './time.js'

export interface ProviderProps {
  csrf: string
  page: string
  api: string
  tab: 'setup' | 'settings' | 'rules' | 'credential'
  tabs: TabLink[]
  rules: RoleRulesProps | null
  credential: ProviderCredentialProps | null
  initials: string
  kind: 'entra' | 'oidc'
  kindLabel: string
  name: string
  issuer: string
  tenantId: string | null
  enabled: boolean
  revision: number
  changed: { actor: string, at: string | null, revision: number }
  credentialConfigured: boolean
  breakGlass: boolean
  problems: string[]
  activationConsequence: string
  redirectUri: string
  logoutUri: string
}

function Activation({ csrf, api, enabled, revision, problems, activationConsequence }: ProviderProps) {
  if (!enabled && problems.length) return <Button type="button" label="Enable sign-in" variant="primary" isDisabled />
  return (
    <ActionForm action={`${api}/activation`} method="PATCH" csrf={csrf} confirmation={{ consequence: activationConsequence }}>
      <Revision value={revision} />
      <input type="hidden" name="enabled" data-type="boolean" value={String(!enabled)} />
      <ActionSubmit label={enabled ? 'Disable sign-in' : 'Enable sign-in'} variant={enabled ? 'secondary' : 'primary'} />
    </ActionForm>
  )
}

function Header(props: ProviderProps) {
  return (
    <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
      <HStack gap={3} vAlign="center">
        <span className="tool-ico lg" aria-hidden="true">{props.initials}</span>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text as="span">{props.kindLabel} · <code>{props.issuer}</code></Text>
          <Badge label={props.enabled ? 'Enabled' : 'Disabled'} variant={props.enabled ? 'success' : 'neutral'} />
        </HStack>
      </HStack>
      <Activation {...props} />
    </HStack>
  )
}

function CopyField({ label, value }: { label: string, value: string }) {
  const { source, status, copy } = useCopy<HTMLInputElement>()
  return (
    <div className="copy-group" data-copy-scope="">
      <div className="copyfield">
        <input ref={source} className="input" readOnly aria-label={label} value={value} />
        <Button type="button" label="Copy" variant="secondary" icon={<Icon name="copy" />} onClick={copy} data-copy="" />
      </div>
      <p className="copy-status" data-copy-status="" role="status">{status}</p>
    </div>
  )
}

function Steps({ steps }: { steps: { done: boolean, title: string, detail: ReactNode }[] }) {
  const current = steps.findIndex(step => !step.done)
  return (
    <ol className="vsteps">
      {steps.map((step, index) => (
        <li key={step.title} className={`vstep${step.done ? ' done' : index === current ? ' current' : ''}`}>
          <span className="mark">{step.done ? <><Icon name="check" /><span className="sr-only">Done:</span></> : index + 1}</span>
          <div><strong>{step.title}</strong>{step.detail}</div>
        </li>
      ))}
    </ol>
  )
}

function breakGlassStep(done: boolean, extra: string) {
  return { done, title: 'Have a break-glass admin ready',
    detail: <p>A separate enabled local administrator with a permanent password, tested in another browser.{extra} <a className="link" href="/admin/users?source=local">Open People</a></p> }
}

function setupSteps({ kind, page, issuer, tenantId, enabled, credentialConfigured, breakGlass, redirectUri }: ProviderProps) {
  const credential = `${page}?tab=credential`
  const rules = `${page}?tab=rules`
  const redirect = <CopyField label="Redirect URI" value={redirectUri} />
  if (kind === 'oidc') {
    return [
      { done: true, title: 'Save the issuer', detail: <p><span className="mono">{issuer}</span>. Discovery runs at sign-in, not while saving.</p> },
      { done: false, title: 'Register Artium as a confidential web app', detail: <><p>Authorization code with PKCE S256, RS256 ID tokens and scopes openid and profile. Register this exact redirect URI:</p>{redirect}</> },
      { done: credentialConfigured, title: 'Save the app credential', detail: <p>private_key_jwt with an RSA certificate (preferred), or a client secret for client_secret_post or client_secret_basic, preferring client_secret_post when discovered. The client ID is the provider’s application identifier. <a className="link" href={credential}>Open Credential</a></p> },
      { done: false, title: 'Include the claims Artium needs', detail: <p><code>preferred_username</code> in ID tokens for invitations, compared exactly, and <code>auth_time</code> for fresh CLI sign-in and identity confirmation. Account identity uses the immutable issuer and sub claims.</p> },
      breakGlassStep(breakGlass, ''),
      { done: false, title: 'Prepare access', detail: <p>Create <a className="link" href="/admin/invitations">invitations</a>, and give people Artium roles directly or with <a className="link" href={rules}>role rules</a>.</p> },
      { done: enabled, title: 'Enable, then test in a separate browser', detail: <p>Claim an invitation, sign in and approve a CLI sign-in while the break-glass session stays open.</p> },
    ]
  }
  return [
    { done: true, title: 'Save the directory tenant', detail: <p>Tenant <span className="mono">{tenantId}</span>. Register the app in Microsoft Entra ID for accounts in this organizational directory only.</p> },
    { done: false, title: 'Add a Web platform redirect URI', detail: <><p>Use the public HTTPS address people use for Artium; check it before copying.</p>{redirect}</> },
    { done: credentialConfigured, title: 'Save the app credential', detail: <p>Upload the public certificate under Certificates &amp; secrets, then save its RSA private key and certificate as one PEM. A client secret is also accepted. <a className="link" href={credential}>Open Credential</a></p> },
    { done: false, title: 'Define app roles', detail: <p>Allowed member types Users/Groups, with exact values such as <code>Artium.Readers</code>. Map them to Artium roles in <a className="link" href={rules}>Role rules</a>.</p> },
    { done: false, title: 'Require assignment', detail: <p>In the enterprise application, set Assignment required to Yes and assign people or groups to app roles. Group assignment needs Entra ID P1 or P2; otherwise assign people directly. Scopes openid and profile are enough; no Graph permission is needed.</p> },
    breakGlassStep(breakGlass, ' Keep offline recover-admin access available.'),
    { done: false, title: 'Prepare invitations', detail: <p>Create <a className="link" href="/admin/invitations">invitations</a>, including a link invitation for an existing administrator who will use SSO. No account is created automatically from a matching role or email.</p> },
    { done: enabled, title: 'Enable, then test in a separate browser', detail: <p>Test one invitation claim and one Microsoft sign-in while the break-glass browser stays open, and confirm the expected roles and tools. Disabling every provider restores ordinary local password sign-in.</p> },
  ]
}

function Readiness({ enabled, problems }: Pick<ProviderProps, 'enabled' | 'problems'>) {
  if (enabled) return <Banner status="success" role="status" icon={<Icon name="check" />} title="Sign-in is enabled" description="Saving provider settings or the credential disables this provider until you enable it again." />
  if (!problems.length) return <Banner status="info" role="status" icon={<Icon name="info" />} title="Ready to enable" description="Credential configuration and a usable break-glass administrator are present." />
  return <Banner status="warning" role="status" icon={<Icon name="alert" />} title="Not ready to enable" description={problems.join(' ')} />
}

function Setup(props: ProviderProps) {
  return (
    <div className="split has-aside">
      <Panel title="Set up this provider" description="Work top to bottom. Artium ticks the steps it can check.">
        <Steps steps={setupSteps(props)} />
      </Panel>
      <VStack gap={4}>
        <Readiness enabled={props.enabled} problems={props.problems} />
        <Text as="p" type="supporting">These checks validate local configuration only. They cannot verify the provider’s app registration, credential acceptance or access policies.</Text>
        <Panel title="What enabling does" description="People sign in with this provider. Local passwords then work only for designated break-glass administrators, and every such use is flagged in the audit log. Disabling every provider restores passwords for everyone." />
        <Panel title="Optional sign-out" description="If the provider supports end-session, register this post-logout URI. Artium sign-out always ends its own session first.">
          <CopyField label="Post-logout URI" value={props.logoutUri} />
        </Panel>
      </VStack>
    </div>
  )
}

function Settings({ csrf, api, kind, name, issuer, tenantId, revision, changed }: ProviderProps) {
  return (
    <ActionForm action={api} method="PATCH" csrf={csrf}
      confirmation={{ consequence: 'Save provider settings and disable this provider? A changed tenant or issuer removes the stored credential. Review configuration and enable it again afterwards.' }}>
      <Panel title="Provider settings" description="Saving disables this provider until you enable it again.">
        <VStack gap={3}>
          <LastChange {...changed} />
          <Revision value={revision} />
          <ProviderFields kind={kind} name={name} identifier={kind === 'entra' ? tenantId ?? '' : issuer} />
          <HStack justify="end"><ActionSubmit label="Save provider settings" variant="primary" /></HStack>
        </VStack>
      </Panel>
    </ActionForm>
  )
}

export function Provider(props: ProviderProps) {
  return (
    <VStack gap={4}>
      <Header {...props} />
      <Tabs label="Sections" tabs={props.tabs} />
      {props.rules ? <RoleRules csrf={props.csrf} page={props.page} rules={props.rules} />
        : props.credential ? <ProviderCredential csrf={props.csrf} api={props.api} providerRevision={props.revision} credential={props.credential} />
          : props.tab === 'setup' ? <Setup {...props} /> : <Settings {...props} />}
    </VStack>
  )
}
