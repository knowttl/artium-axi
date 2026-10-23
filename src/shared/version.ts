import metadata from '../../package.json' with { type: 'json' }

export const cliVersion = metadata.version

// The update command landed in #141; v0.0.10 is the first release containing it.
// This constant is the one authoritative place for that boundary.
export const firstVersionWithUpdate = '0.0.10'

const parseVersion = (version: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version)

// Releases use three numeric components. A prerelease is older than its release.
export function acceptsCliVersion(value: string): boolean {
  const actual = parseVersion(value)
  const required = parseVersion(cliVersion)
  if (!actual || !required) return false
  for (let index = 1; index <= 3; index++) {
    if (BigInt(actual[index]) !== BigInt(required[index])) return BigInt(actual[index]) > BigInt(required[index])
  }
  return actual[4] === undefined || actual[4] === required[4]
}

// Missing or malformed versions return false, so callers fall back to guidance
// that does not assume the update command exists.
export function hasCliUpdateCommand(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const actual = parseVersion(value)
  const first = parseVersion(firstVersionWithUpdate)
  if (!actual || !first) return false
  if (actual[4]?.split('.').some(identifier => !/^[0-9A-Za-z-]+$/.test(identifier) || /^0\d+$/.test(identifier))) return false
  if (actual[5]?.split('.').some(identifier => !/^[0-9A-Za-z-]+$/.test(identifier))) return false
  for (let index = 1; index <= 3; index++) {
    if (BigInt(actual[index]) !== BigInt(first[index])) return BigInt(actual[index]) > BigInt(first[index])
  }
  return actual[4] === undefined
}
