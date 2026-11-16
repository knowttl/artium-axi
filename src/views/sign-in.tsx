import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { ProviderFields } from './provider-fields.js'
import { Sheet, SheetFrame } from './sheet.js'

export interface SignInProps {
  summaries: { label: string, value: string, detail: string, warning: boolean, action: { href: string, label: string } | null }[]
  providers: { href: string, name: string, initials: string, kind: string, issuer: string, configured: boolean, enabled: boolean }[]
  addHref: string
  add: { open: 'add-provider' | 'add-entra' | 'add-oidc' | null, closeHref: string, csrf: string }
}

const kinds = [
  { value: 'entra', name: 'Microsoft Entra ID', detail: 'Single-tenant app registration. Uses the directory tenant ID. Roles map from app roles.' },
  { value: 'oidc', name: 'OpenID Connect', detail: 'Any standards-compliant provider, using its exact HTTPS issuer. Roles map from any claim.' },
]

function AddProvider({ open, closeHref, csrf }: SignInProps['add']) {
  if (open === 'add-provider') {
    return (
      <SheetFrame name="add-provider" open closeHref={closeHref} title="Add a sign-in provider" description="Pick the kind of identity provider. You configure its credential and rules next.">
        <form method="get" action={closeHref}>
          <div className="sheet-body">
            <fieldset className="options">
              <legend className="sr-only">Kind of identity provider</legend>
              {kinds.map(kind => (
                <label key={kind.value} className="option">
                  <input type="radio" name="sheet" value={`add-${kind.value}`} defaultChecked={kind.value === 'entra'} />
                  <div><strong>{kind.name}</strong><span>{kind.detail}</span></div>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="sheet-foot">
            <Button href={closeHref} label="Cancel" variant="ghost" data-sheet-close="" />
            <Button type="submit" label="Continue" variant="primary" />
          </div>
        </form>
      </SheetFrame>
    )
  }
  if (!open) return null
  const kind = open === 'add-entra' ? 'entra' : 'oidc'
  return (
    <Sheet name={open} open closeHref={closeHref} title={kind === 'entra' ? 'Add an Entra ID provider' : 'Add an OpenID Connect provider'}
      description="The provider starts disabled. Save its credential and test break-glass access before enabling it." submit="Add provider" confirmTitle="Add provider?"
      action="/v1/admin/sso/providers" csrf={csrf} consequence="Create a disabled provider?" successUrl={closeHref}>
      <ProviderFields kind={kind} name="" identifier="" />
    </Sheet>
  )
}

export function SignIn({ summaries, providers, addHref, add }: SignInProps) {
  return (
    <VStack gap={4}>
      <section aria-labelledby="sign-in-summary">
        <VisuallyHidden as="h2" id="sign-in-summary">Summary</VisuallyHidden>
        <Grid columns={{ minWidth: 220, repeat: 'fit' }} gap={3}>
          {summaries.map(summary => (
            <Card key={summary.label} role="region" aria-label={summary.label}>
              <VStack gap={1}>
                <Text type="label">{summary.label}</Text>
                <Text as="p" type="large">{summary.warning ? <Badge label={summary.value} variant="warning" /> : <strong>{summary.value}</strong>}</Text>
                <Text as="p" type="supporting">{summary.detail}</Text>
                {summary.action && <HStack><Button href={summary.action.href} label={summary.action.label} variant="secondary" size="sm" /></HStack>}
              </VStack>
            </Card>
          ))}
        </Grid>
      </section>
      <Panel title="Providers" description="New providers start disabled.">
        {providers.length ? (
          <Table aria-label="Providers" scrollWrapper={({ children }) => <div className="table-wrap providers-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell scope="col">Provider</TableHeaderCell>
                <TableHeaderCell scope="col">Status</TableHeaderCell>
                <TableHeaderCell scope="col"><VisuallyHidden>Open</VisuallyHidden></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map(provider => (
                <TableRow key={provider.href} {...{ 'data-provider': provider.href }}>
                  <TableCell>
                    <HStack gap={2} vAlign="center">
                      <span className="tool-ico" aria-hidden="true">{provider.initials}</span>
                      <VStack gap={0}>
                        <a href={provider.href}><strong>{provider.name}</strong></a>
                        <Text type="supporting">{provider.kind} · <code>{provider.issuer}</code></Text>
                      </VStack>
                    </HStack>
                  </TableCell>
                  <TableCell data-label="Status">
                    <HStack gap={1} wrap="wrap">
                      {!provider.configured && <Badge label="Needs credential" variant="warning" />}
                      <Badge label={provider.enabled ? 'Enabled' : 'Disabled'} variant={provider.enabled ? 'success' : 'neutral'} />
                    </HStack>
                  </TableCell>
                  <TableCell>
                    <Button href={provider.href} label={`${provider.enabled ? 'Open' : 'Continue setup of'} ${provider.name}`} variant="secondary" size="sm">
                      {provider.enabled ? 'Open' : 'Continue setup'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No providers yet" headingLevel={3} description="Add one, then save its credential."
            actions={<Button href={addHref} label="Add provider" variant="secondary" size="sm" icon={<Icon name="plus" />} />} />
        )}
      </Panel>
      <AddProvider {...add} />
    </VStack>
  )
}
