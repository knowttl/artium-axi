import metadata from '../../package.json' with { type: 'json' }

export const cliVersion = metadata.version

// Releases use three numeric components. A prerelease is older than its release.
export function acceptsCliVersion(value: string): boolean {
  const parse = (version: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  const actual = parse(value)
  const required = parse(cliVersion)
  if (!actual || !required) return false
  for (let index = 1; index <= 3; index++) {
    if (BigInt(actual[index]) !== BigInt(required[index])) return BigInt(actual[index]) > BigInt(required[index])
  }
  return actual[4] === undefined || actual[4] === required[4]
}
