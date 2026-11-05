import { expect, test } from 'vitest'
import { commandHelp, delegatedDownloadHelp } from './help.js'
import type { TransferScope } from '../shared/api.js'

test.each<{ operation: TransferScope['selection']['operation'], selection: string }>([
  { operation: 'api-definition.download', selection: '--selector api --type yaml' },
  { operation: 'email.download', selection: '--selector <entity-id> --type <email|original>' },
  { operation: 'mail.message.export', selection: '--selector <mailbox/message-id> --type mime' },
  { operation: 'gitea.release.download', selection: '--selector <OWNER/REPO/TAG/ASSET-ID> --type attachment (tags may contain slashes)' },
])('download help retains the $operation selector and type contract (R3)', ({ operation, selection }) => {
  const help = delegatedDownloadHelp([operation])
  expect(help).toContain(`${operation}: ${selection}`)
  expect(help).toContain('--destination <absolute-new-path> (required; Linux private 0700 directory, no symlink components or overwrite)')
  expect(help).not.toContain('hash-download-bin')
  expect(commandHelp('download')).toContain(`${operation}: ${selection}`)
})
