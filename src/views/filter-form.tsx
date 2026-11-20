import { Button } from '@astryxdesign/core/Button'
import { useEffect, useState, type ReactNode } from 'react'

export function FilterForm({ action, apply, trailing, children }: { action: string, apply?: 'always' | 'until-hydrated', trailing?: ReactNode, children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <form className="filters" method="get" action={action} data-hydrated={hydrated || undefined}
      onChange={event => { if (event.target instanceof HTMLSelectElement) event.currentTarget.requestSubmit() }}
      onSubmit={event => {
        event.preventDefault()
        const query = new URLSearchParams()
        for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value !== '') query.set(name, value)
        location.assign(`${event.currentTarget.action}?${query}`)
      }}>
      {children}
      {apply && <Button type="submit" label="Apply" variant="secondary" size="sm" {...{ hidden: apply === 'until-hydrated' && hydrated }} />}
      {trailing}
    </form>
  )
}
