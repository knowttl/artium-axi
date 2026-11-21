import { Button } from '@astryxdesign/core/Button'
import type { ReactNode } from 'react'
import { useHydrated } from './hydrated.js'

export function FilterForm({ action, apply, trailing, children }: { action: string, apply?: 'always' | 'until-hydrated', trailing?: ReactNode, children: ReactNode }) {
  const hydrated = useHydrated()
  return (
    <form className="filters" method="get" action={action}
      onChange={event => { if (event.target instanceof HTMLSelectElement) event.currentTarget.requestSubmit() }}
      onSubmit={event => {
        event.preventDefault()
        const query = new URLSearchParams()
        for (const [name, value] of new FormData(event.currentTarget)) if (value !== '') query.set(name, String(value))
        location.assign(`${event.currentTarget.action}?${query}`)
      }}>
      {children}
      {apply && <Button type="submit" label="Apply" variant="secondary" size="sm" {...{ hidden: apply === 'until-hydrated' && hydrated }} />}
      {trailing}
    </form>
  )
}
