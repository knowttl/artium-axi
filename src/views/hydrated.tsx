import { useSyncExternalStore, type ReactNode } from 'react'

const subscribe = () => () => {}

export const useHydrated = () => useSyncExternalStore(subscribe, () => true, () => false)

export function HydrationGate({ children, allowBeforeHydration }: { children: ReactNode, allowBeforeHydration?: boolean }) {
  const hydrated = useHydrated()
  return <fieldset data-hydration-gate="" disabled={!hydrated && !allowBeforeHydration}>{children}</fieldset>
}
