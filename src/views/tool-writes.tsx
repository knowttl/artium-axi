import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useLayoutEffect, useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'

type Show = 'all' | 'selected' | 'deletes'
interface Operation { name: string, label: string, search: string, delete: boolean, bulk: boolean, checked: boolean }
interface OperationGroup { title: string, family: string | null, deletes: number, notUsed: boolean, operations: Operation[] }

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
    familyNote: string
    q: string
    show: Show
    deleteCount: number
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

function SelectControls({ scope, hidden, onSelect }: { scope: string, hidden: boolean, onSelect: (on: boolean) => void }) {
  return (
    <div className="ops-actions" hidden={hidden}>
      <Button label="Select all" variant="ghost" size="sm" data-ops-select="all" onClick={() => onSelect(true)} {...{ 'aria-label': `Select all ${scope}` }} />
      <Button label="Clear all" variant="ghost" size="sm" data-ops-select="none" onClick={() => onSelect(false)} {...{ 'aria-label': `Clear all ${scope}` }} />
    </div>
  )
}

interface Picker { query: string, show: Show, checked: ReadonlySet<string>, open: ReadonlySet<number> }

const isFiltering = ({ query, show }: Picker) => query.trim() !== '' || show !== 'all'

function shownOperations(group: OperationGroup, { query, show, checked }: Picker) {
  const text = query.trim().toLowerCase()
  return group.operations.filter(operation => operation.search.includes(text)
    && (show === 'all' || (show === 'selected' ? checked.has(operation.name) : operation.delete)))
}

function openMatchingGroups(groups: OperationGroup[], picker: Picker): Picker {
  if (!isFiltering(picker)) return picker
  return { ...picker, open: new Set([...picker.open, ...groups.flatMap((group, index) => shownOperations(group, picker).length ? [index] : [])]) }
}

function startingPicker(groups: OperationGroup[], query: string, show: Show): Picker {
  const checked = new Set(groups.flatMap(group => group.operations.filter(operation => operation.checked).map(operation => operation.name)))
  const picker = { query, show, checked, open: new Set<number>() }
  if (isFiltering(picker)) return openMatchingGroups(groups, picker)
  return { ...picker, open: new Set(groups.flatMap((group, index) => index === 0 || group.operations.some(operation => checked.has(operation.name)) ? [index] : [])) }
}

function Operations({ q, show, deleteCount, groups, supported, familyNote }: NonNullable<WritesProps['operations']>) {
  const [picker, setPicker] = useState(() => startingPicker(groups, q, show))
  const [hydrated, setHydrated] = useState(false)
  useLayoutEffect(() => setHydrated(true), [])
  const update = (change: (current: Picker) => Partial<Picker>) => setPicker(current => openMatchingGroups(groups, { ...current, ...change(current) }))
  const select = (scope: OperationGroup[], on: boolean) => update(current => {
    const checked = new Set(current.checked)
    for (const operation of scope.flatMap(group => shownOperations(group, current))) {
      if (on) checked.add(operation.name)
      else checked.delete(operation.name)
    }
    return { checked }
  })
  const shown = new Set(groups.flatMap(group => shownOperations(group, picker).map(operation => operation.name)))
  const showLabels = { all: 'All', selected: 'Selected', deletes: `Deletes ${deleteCount}` }
  return (
    <Panel title="Allowed operations" description={<><span data-ops-selected="">{picker.checked.size}</span>{` of ${supported} selected. Unselected operations stay blocked. At least one is required to turn writes on.${familyNote}`}</>}>
      <VStack gap={3}>
        <HStack className="filters" gap={2} vAlign="center" wrap="wrap">
          <TextInput label="Filter operations" isLabelHidden type="search" htmlName="q" value={picker.query} onChange={query => update(() => ({ query }))} startIcon={<Icon name="search" />} size="sm" width={360}
            placeholder="Filter operations, for example note or close" {...{ form: 'ops-filter' }} />
          <div className="seg" role="radiogroup" aria-label="Show">
            {(['all', 'selected', 'deletes'] as const).map(value => (
              <label key={value}><input className="sr-only" type="radio" name="show" value={value} form="ops-filter" checked={picker.show === value} onChange={() => update(() => ({ show: value }))} />{showLabels[value]}</label>
            ))}
          </div>
          <Button type="submit" label="Apply" variant="secondary" size="sm" {...{ form: 'ops-filter', hidden: hydrated }} />
        </HStack>
        <SelectControls scope="shown operations" hidden={!hydrated} onSelect={on => select(groups, on)} />
        <div className="ops">
          {groups.map((group, index) => {
            const picked = group.operations.filter(operation => picker.checked.has(operation.name)).length
            return (
            <details key={index} className="ops-group" data-ops-group="" open={picker.open.has(index)}
              hidden={isFiltering(picker) && !group.operations.some(operation => shown.has(operation.name))}
              onToggle={event => {
                const open = event.currentTarget.open
                if (open !== picker.open.has(index)) setPicker(current => ({ ...current, open: new Set(open ? [...current.open, index] : [...current.open].filter(item => item !== index)) }))
              }}>
              <summary>
                <Icon name="chev" />
                <b>{group.title}</b>
                <span className="muted">
                  {group.family ? `${group.family} · ` : ''}{group.operations.length} operation{group.operations.length === 1 ? '' : 's'}
                  <span data-ops-picked="">{picked ? ` · ${picked} selected` : ''}</span>{group.notUsed ? ' · not used by this deployment' : ''}
                </span>
                {group.deletes > 0 && <span className="end"><Badge label={`${group.deletes} delete${group.deletes === 1 ? '' : 's'}`} variant="error" /></span>}
              </summary>
              <div className="ops-body">
                <SelectControls scope={`operations in ${group.title}`} hidden={!hydrated} onSelect={on => select([group], on)} />
                {group.operations.map(operation => (
                  <label key={operation.name} className="op" data-op={operation.search} data-delete={operation.delete ? '' : undefined} hidden={!shown.has(operation.name)}>
                    <input type="checkbox" name="operations" data-type="array" value={operation.name} checked={picker.checked.has(operation.name)}
                      onChange={event => { const on = event.currentTarget.checked; update(current => ({ checked: new Set(on ? [...current.checked, operation.name] : [...current.checked].filter(name => name !== operation.name)) })) }} />
                    <span>{operation.label}</span>
                    {operation.label !== operation.name && <code>{operation.name}</code>}
                    {operation.delete && <Badge label="Delete" variant="error" />}
                    {operation.bulk && <Badge label="Bulk" variant="warning" />}
                  </label>
                ))}
              </div>
            </details>
            )
          })}
        </div>
        <Text as="p" type="supporting" {...{ 'data-ops-empty': '', hidden: shown.size > 0 }}>No operations match this filter.</Text>
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
            {operations && <form id="ops-filter" method="get" action={`/admin/tools/${name}`} hidden onSubmit={event => event.preventDefault()}><input type="hidden" name="tab" value="writes" /></form>}
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
