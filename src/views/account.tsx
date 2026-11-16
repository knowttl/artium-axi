import { Badge } from '@astryxdesign/core/Badge'
import { Card } from '@astryxdesign/core/Card'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { Fragment } from 'react'
import { Icon } from './icon.js'
import { Panel } from './panel.js'

type Rich = (string | { code: string })[]

export interface AccountGuideProps {
  tools: { mark: string, name: string, available: boolean }[]
  cli: {
    download: string
    signIn: string
    signInHelp: string
    hosts: { id: string, label: string, command: string }[]
  }
  saving: null | {
    tools: string
    paragraphs: Rich[]
    sections: { title: string, before: Rich[], command: string | null, after: Rich[] }[]
    transfers: { tool: string, type: string, selector: string, bytes: string, sha256: string, native: string, delivered: string, outcome: string, receipt: string }[]
  }
}

function Inline({ parts }: { parts: Rich }) {
  return <>{parts.map((part, index) => typeof part === 'string' ? <Fragment key={index}>{part}</Fragment> : <code key={index}>{part.code}</code>)}</>
}

function CopyBlock({ label, text }: { label: string, text: string }) {
  return (
    <div className="copyblock" data-copy-scope="">
      <pre className="code" aria-label={label}>{text}</pre>
      <button type="button" className="btn btn-secondary btn-sm" data-copy="" aria-label={`Copy: ${label}`}><Icon name="copy" />Copy</button>
      <p className="copy-status" role="status" data-copy-status="" />
    </div>
  )
}

function Step({ number, current, title, children }: { number: number, current?: boolean, title: string, children: React.ReactNode }) {
  return (
    <li className={`vstep${current ? ' current' : ''}`}>
      <span className="mark">{number}</span>
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </li>
  )
}

function Tools({ tools }: Pick<AccountGuideProps, 'tools'>) {
  return (
    <Panel title="Your tools" description="From your roles. Ask an administrator to change your roles or configure a tool.">
      {tools.length ? (
        <ul className="tool-grid">
          {tools.map(tool => (
            <li key={tool.name}>
              <span className="tool-ico" aria-hidden="true">{tool.mark}</span>
              <div>
                <strong>{tool.name}</strong>
                {tool.available ? <Badge label="Available" variant="success" /> : <Badge label="Turned off by admin" variant="neutral" />}
              </div>
            </li>
          ))}
        </ul>
      ) : <Text as="p">No tools granted. Ask an administrator to assign a role that grants the tools you need.</Text>}
    </Panel>
  )
}

function Cli({ cli }: Pick<AccountGuideProps, 'cli'>) {
  return (
    <Panel title="Set up the CLI" description="Linux with Node 24.11 or later, curl and sha256sum.">
      <ol className="vsteps">
        <Step number={1} current title="Download and verify">
          <p>From this trusted server. Stop if download or verification fails; the checksum detects corruption, so trust the server URL first.</p>
          <CopyBlock label="Download and verify commands" text={cli.download} />
          <p className="hint">Private CA? Add <code>--cacert</code> with your CA file to both curl commands and set <code>ARTIUM_AXI_CA_FILE</code> for the CLI. Keep certificate verification enabled.
            Or download the <a href="/cli/artium-axi.mjs">CLI</a> and its <a href="/cli/artium-axi.mjs.sha256">SHA-256 checksum</a> directly.</p>
        </Step>
        <Step number={2} title="Sign in">
          <CopyBlock label="Sign-in commands" text={cli.signIn} />
          <p className="hint">{cli.signInHelp}</p>
        </Step>
        <Step number={3} title="Connect your agent">
          <div className="hosts">
            <div className="seg" role="radiogroup" aria-label="Agent host">
              {cli.hosts.map(({ id, label }, index) => (
                <Fragment key={id}>
                  <input type="radio" name="host" id={`host-${id}`} value={id} defaultChecked={index === 0} />
                  <label htmlFor={`host-${id}`}>{label}</label>
                </Fragment>
              ))}
            </div>
            {cli.hosts.map(({ id, label, command }) => <div key={id} className={`host-command ${id}`}><CopyBlock label={`Set up ${label}`} text={command} /></div>)}
          </div>
          <p className="hint">Setup installs skills for your granted tools. Run it again after you get new tools.</p>
        </Step>
      </ol>
    </Panel>
  )
}

function Saving({ saving }: { saving: NonNullable<AccountGuideProps['saving']> }) {
  return (
    <Card padding={0}>
      <details className="disclosure">
        <summary className="list-row">
          <Icon name="download" />
          <div className="grow">
            <strong>Saving files from tools</strong>
            <p>{saving.tools}. Saves happen only through the CLI on a controlled Linux host; the browser never handles the files.</p>
          </div>
          <Icon name="chevd" />
        </summary>
        <div className="card-body">
          <VStack gap={3}>
            {saving.paragraphs.map((parts, index) => <Text key={index} as="p"><Inline parts={parts} /></Text>)}
            {saving.sections.map(section => (
              <VStack key={section.title} gap={2}>
                <Heading level={3}>{section.title}</Heading>
                {section.before.map((parts, index) => <Text key={index} as="p"><Inline parts={parts} /></Text>)}
                {section.command && <pre className="code">{section.command}</pre>}
                {section.after.map((parts, index) => <Text key={index} as="p"><Inline parts={parts} /></Text>)}
              </VStack>
            ))}
            <Heading level={3}>Your latest 20 archive transfers</Heading>
            {saving.transfers.length ? (
              <Table aria-label="Your latest 20 archive transfers" scrollWrapper={({ children }) => <div className="table-wrap">{children}</div>}>
                <TableHeader>
                  <TableRow isHeaderRow>
                    {['Tool', 'Type', 'Selector', 'Bytes', 'Archive SHA-256', 'Native outcome', 'Delivery', 'Service outcome', 'Client save receipt'].map(heading => <TableHeaderCell key={heading} scope="col">{heading}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {saving.transfers.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>{row.tool}</TableCell>
                      <TableCell>{row.type}</TableCell>
                      <TableCell><span className="mono">{row.selector}</span></TableCell>
                      <TableCell>{row.bytes}</TableCell>
                      <TableCell><span className="mono">{row.sha256}</span></TableCell>
                      <TableCell>{row.native}</TableCell>
                      <TableCell>{row.delivered}</TableCell>
                      <TableCell>{row.outcome}</TableCell>
                      <TableCell>{row.receipt}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <Text as="p">No archive transfers recorded.</Text>}
          </VStack>
        </div>
      </details>
    </Card>
  )
}

export function AccountGuide({ tools, cli, saving }: AccountGuideProps) {
  return (
    <VStack gap={4}>
      <Tools tools={tools} />
      <Cli cli={cli} />
      {saving && <Saving saving={saving} />}
    </VStack>
  )
}
