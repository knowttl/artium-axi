import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'
import { deliverPrivateResult } from './private-result.js'

export async function kubernetesCredential(createClient: () => Client, supplied: string[], output: (text: string) => void) {
  const json = supplied.includes('--json'), args = supplied.filter(arg => arg !== '--json')
  const print = (value: unknown) => output((json ? JSON.stringify(value) : encode(value)) + '\n')
  if (args.length === 2 && args[1] === '--help') {
    print({ usage: 'artium-axi kubernetes-axi credential <result-id> --credential-fd <private-pipe-fd>',
      help: ['Retrieve a token-create result once, within five minutes, using the same caller and sign-in family.',
        'Use an inherited writable private pipe distinct from stdin, stdout, stderr and reserved session descriptors 3 and 4.',
        'No token bytes enter routine output or files. An interrupted delivery is never retried.'] })
    return true
  }
  if (args.length !== 4 || !z.uuid().safeParse(args[1]).success || args[2] !== '--credential-fd'
    || !/^[1-9][0-9]*$/.test(args[3]) || !Number.isSafeInteger(Number(args[3])) || Number(args[3]) < 5) throw new ArtiumError('INVALID_INPUT')
  await deliverPrivateResult(createClient, { tool: 'kubernetes-axi', operation: 'token-create', id: args[1], fd: args[3], json }, output)
  return true
}
