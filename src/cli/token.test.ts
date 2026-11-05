import { expect, test } from 'vitest'
import { tokenCommand } from './token.js'

test.each([
  { selections: ['--exact', 'awx-axi:*'] },
  { selections: ['--exact', 'awx-axi:job *'] },
  { selections: ['--command', 'awx-axi:job *', '--exact', 'awx-axi:user *'] },
  { selections: ['--command', 'az-axi:security alert list *'] },
])('wildcard selections are refused before authentication (R12, R25): $selections', async ({ selections }) => {
  await expect(tokenCommand(['create', '--label', 'Synthetic', '--expires', '2030-01-01T00:00:00Z', ...selections], () => undefined))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Wildcards are not supported yet.', next: 'Select exact commands or use --tool for tool-wide access.' })
})
