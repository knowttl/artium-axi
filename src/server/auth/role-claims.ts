export type RoleClaims = Record<string, string[]>

// Only exact string values participate in role rules; objects and numbers do not.
export function roleClaims(claims: Record<string, unknown>): RoleClaims {
  return Object.fromEntries(Object.entries(claims).flatMap(([name, value]) => {
    const values = typeof value === 'string' ? [value] : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string') : []
    return values.length ? [[name, values]] : []
  }))
}

export function matchesClaim(claims: RoleClaims, rule: { claim: string, value: string }): boolean {
  return Object.hasOwn(claims, rule.claim) && claims[rule.claim].includes(rule.value)
}
