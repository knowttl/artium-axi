import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'

interface Operation { name: string, label: string, search: string, delete: boolean, bulk: boolean, checked: boolean, hidden: boolean }
interface OperationGroup { title: string, family: string | null, picked: number, deletes: number, notUsed: boolean, open: boolean, hidden: boolean, operations: Operation[] }

export interface WritesProps {
  capable: boolean
  readOnlyReason: string
  blockedTitle: string
  blocked: string
  unlocks: string
  grant: string
  unsupported: boolean
  confirmation: string
  switches: { name: string, label: string, on: boolean, text: string }[]
  operations: {
    supported: number
    selected: number
    familyNote: string
    q: string
    show: 'all' | 'selected' | 'deletes'
    deleteCount: number
    empty: boolean
    groups: OperationGroup[]
  } | null
}

const SAVED = 'Saving keeps the credential and other settings. Audited.'

function Switches({ switches }: Pick<WritesProps, 'switches'>) {
  return switches.map(item => (
    <label key={item.name} className="switch-row">
      <input type="checkbox" className="switch" role="switch" name={item.name} data-type="boolean" defaultChecked={item.on} />
      <div><b>{item.label}</b><span>{item.text}</span></div>
    </label>
  ))
}

function SelectControls({ scope }: { scope: string }) {
  return (
    <div className="ops-actions" data-ops-actions="" hidden>
      <Button label="Select all" variant="ghost" size="sm" data-ops-select="all" {...{ 'aria-label': `Select all ${scope}` }} />
      <Button label="Clear all" variant="ghost" size="sm" data-ops-select="none" {...{ 'aria-label': `Clear all ${scope}` }} />
    </div>
  )
}

function Operations({ q, show, deleteCount, groups, empty, selected, supported, familyNote }: NonNullable<WritesProps['operations']>) {
  const [query, setQuery] = useState(q)
  const showLabels = { all: 'All', selected: 'Selected', deletes: `Deletes ${deleteCount}` }
  return (
    <Panel title="Allowed operations" description={<><span data-ops-selected="">{selected}</span>{` of ${supported} selected. Unselected operations stay blocked. At least one is required to turn writes on.${familyNote}`}</>}>
      <VStack gap={3}>
        <HStack className="filters" gap={2} vAlign="center" wrap="wrap" {...{ 'data-ops-filter': '' }}>
          <TextInput label="Filter operations" isLabelHidden type="search" htmlName="q" value={query} onChange={setQuery} startIcon={<Icon name="search" />} size="sm" width={360}
            placeholder="Filter operations, for example note or close" {...{ form: 'ops-filter' }} />
          <div className="seg" role="radiogroup" aria-label="Show">
            {(['all', 'selected', 'deletes'] as const).map(value => (
              <label key={value}><input className="sr-only" type="radio" name="show" value={value} form="ops-filter" defaultChecked={show === value} />{showLabels[value]}</label>
            ))}
          </div>
          <Button type="submit" label="Apply" variant="secondary" size="sm" data-ops-apply="" {...{ form: 'ops-filter' }} />
        </HStack>
        <SelectControls scope="shown operations" />
        <div className="ops">
          {groups.map((group, index) => (
            <details key={index} className="ops-group" data-ops-group="" open={group.open} hidden={group.hidden}>
              <summary>
                <Icon name="chev" />
                <b>{group.title}</b>
                <span className="muted">
                  {group.family ? `${group.family} · ` : ''}{group.operations.length} operation{group.operations.length === 1 ? '' : 's'}
                  <span data-ops-picked="">{group.picked ? ` · ${group.picked} selected` : ''}</span>{group.notUsed ? ' · not used by this deployment' : ''}
                </span>
                {group.deletes > 0 && <span className="end"><Badge label={`${group.deletes} delete${group.deletes === 1 ? '' : 's'}`} variant="error" /></span>}
              </summary>
              <div className="ops-body">
                <SelectControls scope={`operations in ${group.title}`} />
                {group.operations.map(operation => (
                  <label key={operation.name} className="op" data-op={operation.search} data-delete={operation.delete ? '' : undefined} hidden={operation.hidden}>
                    <input type="checkbox" name="operations" data-type="array" value={operation.name} defaultChecked={operation.checked} />
                    <span>{operation.label}</span>
                    {operation.label !== operation.name && <code>{operation.name}</code>}
                    {operation.delete && <Badge label="Delete" variant="error" />}
                    {operation.bulk && <Badge label="Bulk" variant="warning" />}
                  </label>
                ))}
              </div>
            </details>
          ))}
        </div>
        <Text as="p" type="supporting" {...{ 'data-ops-empty': '', hidden: !empty }}>No operations match this filter.</Text>
      </VStack>
    </Panel>
  )
}

export function Writes({ csrf, name, api, product, revision, panel }: { csrf: string, name: string, api: string, product: string, revision: number, panel: WritesProps }) {
  const { capable, readOnlyReason, blockedTitle, blocked, unlocks, grant, unsupported, confirmation, switches, operations } = panel
  const save = <Button type="submit" label="Save write permissions" variant="primary" size="sm" />
  return (
    <div className="split has-aside" data-write-access="">
      <VStack gap={4}>
        {!capable ? (
          <Panel title="Always read-only" description={`${product} cannot change data through Artium.`}>
            <Text as="p">{readOnlyReason}</Text>
            <Text as="p">No write actions are currently granted.</Text>
          </Panel>
        ) : (
          <>
            {unsupported && <Banner status="error" icon={<Icon name="alert" />} title="Unsupported operations saved"
              description="The saved allow-list contains operations outside the pinned catalogue. Saving write permissions removes them." {...{ role: 'alert' }} />}
            <ActionForm action={`${api}/write-access`} method="PATCH" csrf={csrf} confirmation={{ consequence: confirmation }}>
              <VStack gap={4}>
                <Revision value={revision} />
                <Panel title="Write access"><VStack gap={0}><Switches switches={switches} /></VStack></Panel>
                {operations && <Operations {...operations} />}
                <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
                  <Text type="supporting">{SAVED}</Text>
                  {save}
                </HStack>
              </VStack>
            </ActionForm>
            <Text as="p" type="supporting">{grant}</Text>
            {operations && <form id="ops-filter" method="get" action={`/admin/tools/${name}`} hidden><input type="hidden" name="tab" value="writes" /></form>}
          </>
        )}
      </VStack>
      <VStack gap={4}>
        <Panel title={blockedTitle}><Text as="p" type="supporting">{blocked}</Text></Panel>
        {capable && <Banner status="warning" icon={<Icon name="alert" />} title="Read before enabling" description={unlocks} />}
      </VStack>
    </div>
  )
}
