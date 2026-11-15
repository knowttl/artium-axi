import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { Time } from './time.js'

export interface ToolsProps {
  filters: { show: 'all' | 'enabled' | 'attention', q: string, links: { label: string, count: number, href: string, current: boolean }[] }
  tools: { href: string, name: string, product: string, mark: string, version: string, instances: string, failing: string | null, state: Status, enabled: boolean,
    writes: Status, rawApi: string, roles: number, checkedAt: string | null }[]
  certificates: { subject: string, issuer: string, expiresAt: string, fingerprint: string }[]
}

function Filters({ show, q, links }: ToolsProps['filters']) {
  const [query, setQuery] = useState(q)
  return (
    <form className="filters" method="get" action="/admin/tools" data-filters>
      <HStack gap={1} role="group" aria-label="Show">
        {links.map(link => <Button key={link.label} href={link.href} label={`${link.label} ${link.count}`} variant={link.current ? 'secondary' : 'ghost'} size="sm"
          {...{ 'aria-current': link.current ? 'page' : undefined }} />)}
      </HStack>
      {show !== 'all' && <input type="hidden" name="show" value={show} />}
      <TextInput label="Filter tools" isLabelHidden type="search" htmlName="q" value={query} onChange={setQuery} size="sm" width={300} startIcon={<Icon name="search" />}
        placeholder="Filter tools" />
    </form>
  )
}

function TrustedCertificates({ certificates }: Pick<ToolsProps, 'certificates'>) {
  return (
    <Panel title="Server-wide trusted CA bundle" actions={<Badge label="Read-only" variant="neutral" />}
      description={`${certificates.length ? `${certificates.length} certificate${certificates.length === 1 ? '' : 's'}.` : 'None configured.'} An operator sets ARTIUM_AXI_EXTRA_CA_FILE and restarts the server to change it. Per-instance trust is on each instance's page.`}>
      {certificates.length > 0 && (
        <Table aria-label="Server-wide trusted CA bundle" scrollWrapper={({ children }) => <div className="table-wrap">{children}</div>}>
          <TableHeader>
            <TableRow isHeaderRow>
              {['Subject', 'Issuer', 'Expires (UTC)', 'SHA-256 fingerprint'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {certificates.map(certificate => (
              <TableRow key={certificate.fingerprint}>
                <TableCell>{certificate.subject}</TableCell>
                <TableCell>{certificate.issuer}</TableCell>
                <TableCell>{certificate.expiresAt}</TableCell>
                <TableCell><code>{certificate.fingerprint}</code></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

export function Tools({ filters, tools, certificates }: ToolsProps) {
  return (
    <VStack gap={4}>
      <Filters {...filters} />
      {tools.length ? (
        <Card padding={0}>
          <VisuallyHidden as="h2">Tools</VisuallyHidden>
          <Table aria-label="Tools" scrollWrapper={({ children }) => <div className="table-wrap link-rows tools-list">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Tool', 'Instances', 'State', 'Enabled', 'Writes', 'Raw API', 'Roles', 'Last checked'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map(tool => (
                <TableRow key={tool.name}>
                  <TableHeaderCell scope="row">
                    <HStack gap={2} vAlign="center">
                      <span className="tool-ico" aria-hidden="true">{tool.mark}</span>
                      <VStack gap={0}>
                        <a className="row-link" href={tool.href}><strong>{tool.product}</strong></a>
                        <Text type="supporting">{tool.name} · {tool.version}</Text>
                      </VStack>
                    </HStack>
                  </TableHeaderCell>
                  <TableCell data-label="Instances"><Text type="supporting">{tool.instances}</Text></TableCell>
                  <TableCell data-label="State">
                    <Badge label={tool.state.word} variant={badgeVariants[tool.state.tone]} />
                    {tool.failing && <Text as="span" type="supporting">{` ${tool.failing}`}</Text>}
                  </TableCell>
                  <TableCell data-label="Enabled"><Badge label={tool.enabled ? 'On' : 'Off'} variant={tool.enabled ? 'success' : 'neutral'} /></TableCell>
                  <TableCell data-label="Writes">{tool.writes.tone === 'warn' ? <Badge label={tool.writes.word} variant="warning" /> : tool.writes.word}</TableCell>
                  <TableCell data-label="Raw API"><Text type="supporting">{tool.rawApi}</Text></TableCell>
                  <TableCell data-label="Roles">{tool.roles}</TableCell>
                  <TableCell data-label="Last checked"><Text type="supporting"><Time iso={tool.checkedAt} empty="Never" /></Text></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No tools match these filters" headingLevel={2} description="Clear the search or choose another view to see more tools."
            actions={<Button href="/admin/tools" label="Show all tools" variant="secondary" />} />
        </Card>
      )}
      <TrustedCertificates certificates={certificates} />
    </VStack>
  )
}
