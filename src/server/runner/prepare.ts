import type Database from 'better-sqlite3'
import type { Adapter } from '../adapters/types.js'
import { verifyAccessToken } from '../auth/tokens.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'

// The HTTP run flow must validate bounded request inputs before calling this function.
export async function prepareToolRun<Credential>(
  db: Database.Database,
  token: string,
  args: readonly string[],
  adapter: Adapter<Credential>,
  resolver: IdentityResolver,
) {
  const userId = verifyAccessToken(db, token)
  checkToolPolicy(db, userId, adapter.name)
  adapter.validateArgs(args)
  const reference = await resolver.resolve(userId, adapter.name)
  const prepared = await adapter.prepare(args, reference)
  return { userId, prepared }
}
