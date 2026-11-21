interface Constraint {
  required?: string[]
  not?: Constraint & { anyOf?: Constraint[] }
}

interface Schema extends Constraint {
  oneOf?: (Constraint & { properties?: Properties })[]
  allOf?: { if?: Condition, then?: Constraint, else?: Constraint }[]
}

interface Condition {
  required?: string[]
  properties?: Properties
}

type Properties = Record<string, { const?: unknown, enum?: unknown[], pattern?: string, 'x-secret'?: boolean }>

const selectors = ['mode', 'kind', 'auth', 'apiVersion', 'signIn']

function matches({ required = [], properties = {} }: Condition, current: Record<string, unknown>) {
  return required.every(key => current[key] !== null && current[key] !== undefined) &&
    Object.entries(properties).every(([key, rule]) => {
      if (rule.pattern && !rule['x-secret']) return typeof current[key] === 'string' && new RegExp(rule.pattern).test(current[key])
      if (!selectors.includes(key)) return true
      return (!Object.hasOwn(rule, 'const') || current[key] === rule.const) && (!rule.enum || rule.enum.includes(current[key]))
    })
}

export function evaluateCredentialSchema(schema: Record<string, unknown>, identity: Record<string, unknown>, configured: boolean, current: Record<string, unknown>) {
  const { required: always = [], oneOf = [], allOf = [] } = schema as Schema
  const required = new Set(always)
  const forbidden = new Set<string>()
  const constrain = ({ required: names = [], not }: Constraint) => {
    for (const key of names) required.add(key)
    for (const rule of not ? not.anyOf ?? [not] : []) {
      if (rule.required?.length === 1) forbidden.add(rule.required[0]!)
    }
  }
  for (const branch of oneOf) if (matches({ properties: branch.properties }, current)) constrain(branch)
  for (const { if: condition, then, else: otherwise } of allOf) {
    const chosen = condition && (matches(condition, current) ? then : otherwise)
    if (chosen) constrain(chosen)
  }
  if (current.mode === 'delegated') forbidden.add('auth')
  const sameIdentity = configured && Object.entries(identity).every(([key, value]) => (forbidden.has(key) ? null : current[key] ?? null) === value)
  return { required, forbidden, sameIdentity }
}
