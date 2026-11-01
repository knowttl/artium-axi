import { expect, test } from 'vitest'
import { auditOutcome, toolState } from '../src/server/admin/design/status.js'

test.each([
  ['ado-api', 'allowed', null, 'ok'],
  ['ado-api', 'refused', null, 'err'],
  ['transfer', 'ready', null, 'ok'],
  ['transfer', 'delivery-completed', null, 'ok'],
  ['transfer', 'preview', null, 'neutral'],
  ['transfer', 'deleted', null, 'neutral'],
  ['transfer', 'expired', null, 'neutral'],
  ['transfer', 'denied-not-sent', null, 'err'],
  ['transfer', 'native-outcome-unknown', null, 'err'],
  ['transfer', 'upstream-failure', null, 'err'],
  ['transfer', 'delivery-interrupted', null, 'err'],
  ['transfer', 'interrupted', null, 'err'],
  ['run-terminal', 'completed', 0, 'ok'],
  ['run-terminal', 'completed', 1, 'err'],
  ['run-terminal', 'completed', null, 'err'],
  ['run-terminal', 'interrupted', null, 'err'],
  ['run-start', 'started', null, 'neutral'],
  ['admin-change', 'success', null, 'ok'],
  ['sign-in', 'failure', null, 'err'],
  ['denial', 'PERMISSION_DENIED', null, 'err'],
] as const)('R1: %s outcome %s with exit %s has tone %s', (event, outcome, exit_code, tone) => {
  expect(auditOutcome({ event, outcome, exit_code }).tone).toBe(tone)
})

test.each([
  [true, 'checking', 'Checking', 'info'],
  [true, 'disabled', 'Disabled', 'off'],
  [true, 'unknown', 'Not checked', 'neutral'],
  [true, 'ok', 'Healthy', 'ok'],
  [true, 'error', 'Failing', 'err'],
  [true, 'unconfigured', 'Needs credential', 'warn'],
  [false, 'ok', 'Disabled', 'off'],
] as const)('R4: enabled=%s health=%s displays %s', (enabled, status, word, tone) => {
  expect(toolState({ enabled, health: { status, readOnly: true, checkedAt: null, credentialRevision: null, errorCode: null } })).toEqual({ word, tone })
})
