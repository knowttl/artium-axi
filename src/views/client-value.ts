import { useSyncExternalStore } from 'react'

const noSubscription = () => () => {}

export function useClientValue<Value>(client: () => Value, server: Value) {
  return useSyncExternalStore(noSubscription, client, () => server)
}
