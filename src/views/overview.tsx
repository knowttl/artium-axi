import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack } from '@astryxdesign/core/HStack'
import { List, ListItem } from '@astryxdesign/core/List'
import { Step, Stepper } from '@astryxdesign/core/Stepper'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import type { ReactNode } from 'react'

type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off' | 'neutral' | 'solid'
interface Status { word: string, tone: Tone }

export interface OverviewProps {
  stats: { label: string, value: string, note: string, tone?: Tone }[]
  attention: { mark: string, title: string, text: string, status?: Status, href: string, action: string }[]
  attentionEmpty: string
  tools: { name: string, product: string, state: Status, writes: Status, roles: string, checkedAt: string | null }[]
  setupSummary: string
  steps: { title: string, done: boolean, detail: string, href: string, action: string }[]
  changes: { mark: string, title: string, actor: string, at: string }[]
}

const badgeVariants = { ok: 'success', warn: 'warning', err: 'error', info: 'info', off: 'neutral', neutral: 'neutral', solid: 'neutral' } as const

function Panel({ title, description, link, children }: { title: string, description?: string, link?: { href: string, label: string }, children: ReactNode }) {
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={3} justify="between" vAlign="center">
          <VStack gap={0.5}>
            <Heading level={2} accessibilityLevel={2}>{title}</Heading>
            {description && <Text type="supporting">{description}</Text>}
          </VStack>
          {link && <Button href={link.href} label={link.label} variant="ghost" size="sm" />}
        </HStack>
        {children}
      </VStack>
    </Card>
  )
}

function Mark({ text }: { text: string }) {
  return <span aria-hidden="true"><Badge label={text} variant="neutral" /></span>
}

function Time({ iso }: { iso: string | null }) {
  return iso === null ? <>Not checked</> : <time dateTime={iso} title={iso} suppressHydrationWarning>{iso}</time>
}

export function Overview({ stats, attention, attentionEmpty, tools, setupSummary, steps, changes }: OverviewProps) {
  const next = steps.findIndex(step => !step.done)
  return (
    <VStack gap={4}>
      <section aria-labelledby="overview-summary">
        <VisuallyHidden as="h2" id="overview-summary">Summary</VisuallyHidden>
        <Grid columns={{ minWidth: 220, repeat: 'fit' }} gap={3}>
          {stats.map(stat => (
            <Card key={stat.label}>
              <VStack gap={1}>
                <Text type="label">{stat.label}</Text>
                <Text as="p" type="display-3">{stat.value}</Text>
                {stat.tone ? <Badge label={stat.note} variant={badgeVariants[stat.tone]} /> : <Text type="supporting">{stat.note}</Text>}
              </VStack>
            </Card>
          ))}
        </Grid>
      </section>
      <Panel title="Needs attention" description={attention.length ? 'Each item names the broken link and the fix.' : 'No problems reported.'}>
        {attention.length ? (
          <List>
            {attention.map((item, index) => (
              <ListItem key={index} startContent={<Mark text={item.mark} />} description={item.text}
                label={<HStack gap={2} wrap="wrap" vAlign="center">{item.title}{item.status && <Badge label={item.status.word} variant={badgeVariants[item.status.tone]} />}</HStack>}
                endContent={<Button href={item.href} label={item.action} variant="secondary" size="sm" />} />
            ))}
          </List>
        ) : <Text as="p" type="supporting">{attentionEmpty}</Text>}
      </Panel>
      <Panel title="Tools" description="Enabled tools and their last check." link={{ href: '/admin/tools', label: 'All tools' }}>
        {tools.length ? (
          <Table aria-label="Enabled tools" scrollWrapper={({ children }) => <div className="table-wrap overview-tools">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                {['Tool', 'State', 'Writes', 'Roles', 'Last checked'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map(tool => (
                <TableRow key={tool.name}>
                  <TableCell><VStack gap={0}><a href={`/admin/tools/${tool.name}`}>{tool.product}</a><Text type="supporting">{tool.name}</Text></VStack></TableCell>
                  <TableCell><Badge label={tool.state.word} variant={badgeVariants[tool.state.tone]} /></TableCell>
                  <TableCell>{tool.writes.tone === 'warn' ? <Badge label={tool.writes.word} variant="warning" /> : tool.writes.word}</TableCell>
                  <TableCell>{tool.roles}</TableCell>
                  <TableCell><Time iso={tool.checkedAt} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <Text as="p" type="supporting">No tools are enabled yet. Connect one to start.</Text>}
      </Panel>
      <Panel title="Finish setting up" description={setupSummary}>
        <Stepper activeStep={next === -1 ? steps.length : next} label="Setup steps" orientation="vertical">
          {steps.map((step, index) => (
            <Step key={step.title} step={index} label={step.title} description={step.detail} indicator="number" status={step.done ? 'success' : undefined}
              endContent={index === next ? <Button href={step.href} label={step.action} variant="secondary" size="sm" /> : undefined} />
          ))}
        </Stepper>
      </Panel>
      <Panel title="Recent changes" link={{ href: '/admin/audit', label: 'Audit log' }}>
        {changes.length ? (
          <List>
            {changes.map((change, index) => (
              <ListItem key={index} label={change.title} description={<>{change.actor} · <Time iso={change.at} /></>} startContent={<Mark text={change.mark} />} />
            ))}
          </List>
        ) : <Text as="p" type="supporting">No administration changes yet.</Text>}
      </Panel>
    </VStack>
  )
}
