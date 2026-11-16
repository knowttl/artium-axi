import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from './icon.js'

export interface TabLink {
  label: string
  href: string
  icon?: string
  note: string | null
  current: boolean
}

export function Tabs({ label, tabs }: { label: string, tabs: TabLink[] }) {
  return (
    <nav aria-label={label}>
      <HStack gap={1} wrap="wrap">
        {tabs.map(tab => <Button key={tab.href} href={tab.href} label={tab.note ? `${tab.label} ${tab.note}` : tab.label} variant={tab.current ? 'secondary' : 'ghost'} size="sm"
          icon={tab.icon ? <Icon name={tab.icon} /> : undefined} {...{ 'aria-current': tab.current ? 'page' : undefined }} />)}
      </HStack>
    </nav>
  )
}
