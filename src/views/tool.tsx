import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { Tabs } from './tabs.js'
import { Time } from './time.js'
import { Access, type AccessProps } from './tool-access.js'
import { Instances, type InstancesProps } from './tool-instances.js'
import { Writes, type WritesProps } from './tool-writes.js'

export interface ToolProps {
  csrf: string
  name: string
  api: string
  product: string
  mark: string
  version: string
  revision: number
  enabled: boolean
  state: Status
  writes: Status
  checkedAt: string | null
  setup: { title: string, detail: string, at: string | null, state: 'done' | 'fail' | 'todo' }[]
  tabs: { label: string, href: string, icon: string, note: string | null, current: boolean }[]
  panel:
    | { tab: 'instances', instances: InstancesProps }
    | { tab: 'access', access: AccessProps }
    | { tab: 'writes', writes: WritesProps }
    | { tab: 'raw-api', mode: string, options: { mode: string, label: string, detail: string }[], writeRoutes: boolean, write: string, get: string }
    | { tab: 'advanced', writeState: string, guide: string, grantNote: boolean, settings: string }
}

type PanelOf<Tab extends ToolProps['panel']['tab']> = Extract<ToolProps['panel'], { tab: Tab }>

const SAVED = 'Saving keeps the credential and other settings. Audited.'
const stepWords = { done: 'Done', fail: 'Failed', todo: 'To do' }

function Header({ csrf, api, mark, name, version, revision, enabled, state, writes, checkedAt }: ToolProps) {
  return (
    <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
      <HStack gap={3} vAlign="center">
        <span className="tool-ico lg" aria-hidden="true">{mark}</span>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <code>{`${name} · ${version}`}</code>
          <Badge label={state.word} variant={badgeVariants[state.tone]} />
          <Badge label={writes.word} variant={writes.tone === 'warn' ? 'warning' : 'neutral'} />
          <Text as="span" type="supporting">Checked <Time iso={checkedAt} empty="never" /></Text>
        </HStack>
      </HStack>
      <ActionForm action={api} method="PATCH" csrf={csrf}
        confirmation={{ consequence: enabled ? 'Disable this tool and block new calls?' : 'Enable this tool for people whose roles grant access?' }}>
        <Revision value={revision} />
        <input type="hidden" name="enabled" data-type="boolean" value={String(!enabled)} />
        <button type="submit" className="toggle" role="switch" aria-checked={enabled}><span className={`switch${enabled ? ' on' : ''}`} aria-hidden="true" />Enabled</button>
      </ActionForm>
    </HStack>
  )
}

export function Setup({ setup }: { setup: (Pick<ToolProps, 'setup'>['setup'][number] & { test?: boolean })[] }) {
  const current = setup.findIndex(step => step.state !== 'done')
  return (
    <ol className="steps">
      {setup.map((step, index) => (
        <li key={step.title} className={`step ${step.state}${index === current ? ' current' : ''}`} data-test-checklist={step.test ? '' : undefined}>
          <span className="mark" aria-hidden="true">{step.state === 'done' ? <Icon name="check" /> : step.state === 'fail' ? <Icon name="x" /> : index + 1}</span>
          <div><b><span className="sr-only" data-step-state="">{`${stepWords[step.state]}: `}</span>{step.title}</b><span>{step.detail}{step.at && <Time iso={step.at} />}</span></div>
        </li>
      ))}
    </ol>
  )
}

function RawApi({ csrf, api, product, revision, panel }: Pick<ToolProps, 'csrf' | 'api' | 'product' | 'revision'> & { panel: PanelOf<'raw-api'> }) {
  const [write, setWrite] = useState(panel.write)
  const [get, setGet] = useState(panel.get)
  return (
    <div className="split has-aside">
      <VStack gap={4}>
        <ActionForm action={`${api}/raw-api`} method="PATCH" csrf={csrf}
          confirmation={{ consequence: `Change the Raw API mode for ${product}? It applies to every caller on the next call. This change is audited.` }}>
          <Panel title="Raw API mode" description={`The most ${product} raw API calls may do for any caller.`}>
            <VStack gap={3}>
              <fieldset className="options">
                <legend className="sr-only">Raw API mode</legend>
                {panel.options.map(option => (
                  <label key={option.mode} className="option">
                    <input type="radio" name="mode" value={option.mode} defaultChecked={option.mode === panel.mode} />
                    <div><strong>{option.label}</strong><span>{option.detail}</span></div>
                  </label>
                ))}
              </fieldset>
              <Revision value={revision} />
              <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
                <Text type="supporting">{SAVED}</Text>
                <Button type="submit" label="Save Raw API mode" variant="primary" size="sm" />
              </HStack>
            </VStack>
          </Panel>
        </ActionForm>
        <ActionForm action={`${api}/raw-api/routes`} method="PUT" csrf={csrf}
          confirmation={{ consequence: `Change the raw route patterns for ${product}? They apply to every caller on the next call. This change is audited.` }}>
          <Panel title="Route patterns" description={`Which paths ${product} raw calls may use. One pattern per line.`}>
            <VStack gap={3}>
              {panel.writeRoutes
                ? <>
                  <TextArea label="Write routes" htmlName="write" value={write} onChange={setWrite} rows={4} hasSpellCheck={false} {...{ 'data-type': 'lines' }} />
                  <Text as="p" type="supporting">Required for any raw write. Each line is a method and a relative path, such as <code>PATCH _apis/wit/workitems/*</code>. Methods: POST, PATCH, PUT or DELETE.</Text>
                </>
                : <input type="hidden" name="write" data-type="lines" value={panel.write} />}
              <TextArea label="GET routes (optional)" htmlName="get" value={get} onChange={setGet} rows={4} hasSpellCheck={false} {...{ 'data-type': 'lines' }} />
              <Text as="p" type="supporting">Leave empty to allow any path for raw reads. A <code>*</code> segment matches exactly one segment and a final <code>**</code> matches any deeper path.</Text>
              <Revision value={revision} />
              <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
                <Text type="supporting">{SAVED}</Text>
                <Button type="submit" label="Save route patterns" variant="primary" size="sm" />
              </HStack>
            </VStack>
          </Panel>
        </ActionForm>
      </VStack>
      <Panel title="Two settings are required" description={`A raw call needs this mode and the Raw API access switch on a role that grants ${product} to the caller. Set the switch on the role’s page.`} />
    </div>
  )
}

function Advanced({ csrf, api, revision, panel }: Pick<ToolProps, 'csrf' | 'api' | 'revision'> & { panel: PanelOf<'advanced'> }) {
  const [settings, setSettings] = useState(panel.settings)
  return (
    <VStack gap={4}>
      <Banner status="warning" icon={<Icon name="alert" />} title="This replaces all native settings"
        description={`Saving keeps the credential and clears cached health. Omitting write settings turns writes off. Use Write permissions for everyday changes.${panel.grantNote ? ' Per-person grants are managed with the picker on the Access tab. Omitting a policy turns it off and removes its grants.' : ''}`} />
      <ActionForm action={api} method="PATCH" csrf={csrf} confirmation={{ consequence: 'Replace native settings while keeping the credential?' }}>
        <Panel title="Native settings (JSON)" description={`Current: ${panel.writeState}.`}>
          <VStack gap={3}>
            <Revision value={revision} />
            <Text as="p">{panel.guide}</Text>
            {panel.grantNote && <Text as="p" type="supporting">Per-person grants are managed with the picker on the Access tab.</Text>}
            <TextArea label="Native settings (JSON object)" htmlName="nativeSettings" value={settings} onChange={setSettings} rows={10} hasSpellCheck={false}
              {...{ 'data-type': 'json', 'data-json-check': '', required: true }} />
            <p className="note" data-json-status="" data-valid="true" aria-live="polite" suppressHydrationWarning>Valid JSON object.</p>
            <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
              <Text type="supporting">{'{} clears settings.'}</Text>
              <Button type="submit" label="Replace settings" variant="secondary" size="sm" />
            </HStack>
          </VStack>
        </Panel>
      </ActionForm>
    </VStack>
  )
}

export function Tool(props: ToolProps) {
  const { panel } = props
  return (
    <VStack gap={4}>
      <Header {...props} />
      <Setup setup={props.setup} />
      <p className="note" data-test-result="" role="status" suppressHydrationWarning>{''}</p>
      <Tabs label="Tool sections" tabs={props.tabs} />
      {panel.tab === 'instances' ? <Instances {...props} panel={panel.instances} />
        : panel.tab === 'writes' ? <Writes {...props} panel={panel.writes} />
          : panel.tab === 'raw-api' ? <RawApi {...props} panel={panel} />
            : panel.tab === 'advanced' ? <Advanced {...props} panel={panel} />
              : <Access {...props} panel={panel.access} />}
    </VStack>
  )
}
