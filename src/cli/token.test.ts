import { expect, test } from 'vitest'
import { tokenCommand } from './token.js'

test.each([
  { selections: ['--exact', 'awx-axi:*'] },
  { selections: ['--exact', 'awx-axi:job *'] },
  { selections: ['--command', 'awx-axi:job *', '--exact', 'awx-axi:user *'] },
])('--exact rejects wildcard selections before authentication (R12): $selections', async ({ selections }) => {
  await expect(tokenCommand(['create', '--label', 'Synthetic', '--expires', '2030-01-01T00:00:00Z', ...selections], () => undefined))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', message: '--exact does not accept wildcards.', next: 'Use --command for trailing wildcard patterns.' })
})
