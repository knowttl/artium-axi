import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loginResponseSchema } from '../../src/shared/api.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

const configurationCases: { args: string[], path: string, body: unknown, input?: RunInput, unconfirmed?: Record<string, unknown>, preview?: unknown, privateValue?: string }[] = [
  ...['create', 'edit'].map(operation => ({
    args: ['organization', operation, ...(operation === 'create' ? [] : ['42']), '--name', 'Synthetic organization',
      '--description', 'Synthetic automation', '--max-hosts', '0', '--default-environment', '7'],
    path: operation === 'create' ? 'organizations/' : 'organizations/42/',
    body: { name: 'Synthetic organization', description: 'Synthetic automation', max_hosts: 0, default_environment: 7 },
  })),
  ...['add', 'remove'].flatMap(operation => [
    ...[
      { kind: 'user', flag: 'user', route: 'users' }, { kind: 'admin', flag: 'user', route: 'admins' },
      { kind: 'team', flag: 'team', route: 'teams' },
      { kind: 'galaxy-credential', flag: 'credential', route: 'galaxy_credentials' },
      { kind: 'instance-group', flag: 'instance-group', route: 'instance_groups' },
      { kind: 'execution-environment', flag: 'execution-environment', route: 'execution_environments' },
      { kind: 'notification-template', flag: 'notification-template', route: 'notification_templates' },
    ].map(({ kind, flag, route }) => ({
      args: ['organization', `${kind}-${operation}`, '42', `--${flag}`, '7'],
      path: `organizations/42/${route}/`, body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    ...['started', 'success', 'error'].map(event => ({
      args: ['organization', `notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
      path: `organizations/42/notification_templates_${event}/`, body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    { args: ['team', `user-${operation}`, '42', '--user', '7'], path: 'teams/42/users/',
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) } },
  ]),
  ...['create', 'edit'].map(operation => ({
    args: ['team', operation, ...(operation === 'create' ? [] : ['42']), '--name', 'Synthetic team',
      '--organization', '7', '--description', 'Synthetic operators'],
    path: operation === 'create' ? 'teams/' : 'teams/42/',
    body: { name: 'Synthetic team', organization: 7, description: 'Synthetic operators' },
  })),
  ...[
    { flag: 'is-superuser', field: 'is_superuser', value: true },
    { flag: 'is-system-auditor', field: 'is_system_auditor', value: true },
    { flag: 'no-superuser', field: 'is_superuser', value: false },
    { flag: 'no-system-auditor', field: 'is_system_auditor', value: false },
  ].flatMap(({ flag, field, value }) => (value ? ['create', 'edit'] : ['edit']).map(operation => ({
    args: ['user', operation, ...(operation === 'create' ? [] : ['42']), '--username', 'synthetic-person',
      '--first-name', 'Synthetic', '--last-name', 'Person', '--email', 'synthetic@example.test', `--${flag}`],
    path: operation === 'create' ? 'users/' : 'users/42/',
    body: { username: 'synthetic-person', first_name: 'Synthetic', last_name: 'Person', email: 'synthetic@example.test', [field]: value },
  }))),
  ...['create', 'edit'].flatMap(operation => ['file', 'stdin'].map(channel => ({
    args: ['user', operation, operation === 'create' ? 'synthetic-person' : '42', '--password-file', channel === 'stdin' ? '-' : 'password.txt'],
    path: operation === 'create' ? 'users/' : 'users/42/',
    body: { ...(operation === 'create' ? { username: 'synthetic-person' } : {}), password: 'CANARY-user-private-password' },
    input: channel === 'stdin' ? { stdin: 'CANARY-user-private-password\n' } : { files: [upload('password.txt', 'CANARY-user-private-password\n')] },
  }))),
  ...['grant', 'revoke'].flatMap(operation => ['user', 'team'].map(subject => ({
    args: ['role', operation, '42', `--${subject}`, '7'], path: `roles/42/${subject}s/`,
    body: { id: 7, ...(operation === 'revoke' ? { disassociate: true } : {}) },
  }))),
  ...[
    { content: '{"ansible_password":12345678}', bytes: 29, privateValue: '12345678' },
    { content: 'common: &pw CANARY-alias\nansible_password: *pw\n', bytes: 47, privateValue: 'CANARY-alias' },
  ].flatMap(({ content, bytes, privateValue }) => ['inline', 'upload'].map(channel => ({
    args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', channel === 'inline' ? content : 'variables.yml'],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: content }, privateValue,
    input: channel === 'upload' ? { files: [upload('variables.yml', content)] } : {},
    preview: { dry_run: { payload: `[structured input redacted, ${bytes} bytes]` }, input: { variables: `[structured input redacted, ${bytes} bytes]` } },
  }))),
  ...['run', 'a', 'A', 'pending', 'create', 'CONTROLLER_UNREACHABLE', '[redacted]', 'dry_run'].map(value => ({
    args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', JSON.stringify({ mode: value })],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: JSON.stringify({ mode: value }) },
    preview: { dry_run: { action: 'create', type: 'host', would_send: 'POST hosts/', payload: `[structured input redacted, ${Buffer.byteLength(JSON.stringify({ mode: value }))} bytes]` },
      help: ['Re-run with --confirm to create'] },
  })),
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', 'variables.json'], path: 'hosts/',
    body: { name: 'synthetic', inventory: 7, variables: '{"env":"a"}' },
    input: { files: [upload('variables.json', '{"env":"a"}')] } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-'], path: 'credentials/42/', body: { inputs: { password: 'a' } },
    input: { stdin: '{"password":"a"}' } },
  { args: ['team', 'credential-create', '7', '--name', 'Synthetic team credential', '--credential-type', '7', '--inputs-file', 'team.json'], path: 'teams/7/credentials/',
    body: { name: 'Synthetic team credential', credential_type: 7, inputs: { password: 'CANARY-team-password' } },
    input: { files: [upload('team.json', '{"password":"CANARY-team-password"}')] } },
  { args: ['job', 'launch', '43', '--credential-passwords-file', 'passwords.json'], path: 'job_templates/43/launch/',
    unconfirmed: { exitCode: 0 },
    body: { credential_passwords: { ssh_password: 'CANARY-launch-password' } },
    input: { files: [upload('passwords.json', '{"ssh_password":"CANARY-launch-password"}')] } },
  { args: ['credential', 'create', 'Synthetic credential', '--credential-type', '7', '--inputs-file', 'credential.json'], path: 'credentials/',
    body: { name: 'Synthetic credential', credential_type: 7, inputs: { ssh_key_data: 'CANARY-private-key\nsecond-line' } },
    input: { files: [upload('credential.json', '{"ssh_key_data":"CANARY-private-key\\nsecond-line"}')] } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-'], path: 'credentials/42/', body: { inputs: { password: 'CANARY-credential-stdin' } },
    input: { stdin: '{"password":"CANARY-credential-stdin"}' } },
  { args: ['credential', 'create', 'Synthetic stdin credential', '--credential-type', '7', '--inputs-file', '-'], path: 'credentials/',
    body: { name: 'Synthetic stdin credential', credential_type: 7, inputs: { password: 'CANARY-create-stdin' } },
    input: { stdin: '{"password":"CANARY-create-stdin"}' } },
  { args: ['credential', 'edit', '42', '--inputs-file', 'machine.json'], path: 'credentials/42/',
    body: { inputs: { ssh_key_data: 'CANARY-edit-key\nsecond-line', password: 'CANARY-edit-password' } },
    input: { files: [upload('machine.json', '{"ssh_key_data":"CANARY-edit-key\\nsecond-line","password":"CANARY-edit-password"}')] } },
  { args: ['credential', 'copy', '42', '--name', 'Synthetic copied credential'], path: 'credentials/42/copy/',
    body: { name: 'Synthetic copied credential' } },
  { args: ['user', 'create', 'synthetic-person', '--password-file', '-'], path: 'users/', body: { username: 'synthetic-person', password: 'CANARY-user-password' },
    input: { stdin: 'CANARY-user-password\n' } },
  ...['create', 'edit'].flatMap(operation => ['configuration-file', 'config-file'].map(flag => ({
    args: ['notification-template', operation, operation === 'create' ? 'Synthetic notification' : '42',
      ...(operation === 'edit' ? ['--name', 'Synthetic notification'] : []), '--organization', '7', '--notification-type', 'webhook',
      '--description', 'Synthetic webhook', `--${flag}`, 'configuration.json', '--messages-file', 'messages.json'],
    path: operation === 'create' ? 'notification_templates/' : 'notification_templates/42/',
    body: { name: 'Synthetic notification', organization: 7, notification_type: 'webhook', description: 'Synthetic webhook',
      notification_configuration: { token: 'CANARY-notification-token' }, messages: { success: { body: 'CANARY-notification-message' } } },
    input: { files: [upload('configuration.json', '{"token":"CANARY-notification-token"}'),
      upload('messages.json', '{"success":{"body":"CANARY-notification-message"}}')] },
    preview: { input: { notification_configuration: '[structured input redacted, 37 bytes]', messages: '[structured input redacted, 50 bytes]' } },
  }))),
  { args: ['inventory', 'host-bulk-create', '--inventory', '7', '--hosts-file', 'hosts.json'], path: 'bulk/host_create/',
    body: { inventory: 7, hosts: [{ name: 'synthetic-bulk-host', variables: '{"password":"CANARY-bulk-secret"}' }] },
    input: { files: [upload('hosts.json', JSON.stringify([{ name: 'synthetic-bulk-host', variables: '{"password":"CANARY-bulk-secret"}' }]))] } },
  { args: ['inventory', 'host-create', 'synthetic-json-host', '--inventory', '7', '--variables', '{"password":"CANARY-json-variable"}'], path: 'hosts/',
    body: { name: 'synthetic-json-host', inventory: 7, variables: '{"password":"CANARY-json-variable"}' } },
  { args: ['inventory', 'host-create', 'synthetic-yaml-host', '--inventory', '7', '--variables', 'variables.yml'], path: 'hosts/',
    body: { name: 'synthetic-yaml-host', inventory: 7, variables: 'password: CANARY-yaml-variable\n' },
    input: { files: [upload('variables.yml', 'password: CANARY-yaml-variable\n')] } },
  { args: ['inventory', 'create', 'Synthetic inventory', '--organization', '7'], path: 'inventories/', body: { name: 'Synthetic inventory', organization: 7 } },
  { args: ['inventory', 'edit', '42', '--name', 'Updated inventory'], path: 'inventories/42/', body: { name: 'Updated inventory' } },
  ...['create', 'edit'].map(verb => ({
    args: ['inventory', verb, verb === 'create' ? 'Synthetic inventory' : '42', ...(verb === 'create' ? ['--organization', '7'] : []), '--variables', 'inventory.yml'],
    path: verb === 'create' ? 'inventories/' : 'inventories/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic inventory', organization: 7 } : {}), variables: 'mode: synthetic\npassword: CANARY-inventory-variable\n' },
    input: { files: [upload('inventory.yml', 'mode: synthetic\npassword: CANARY-inventory-variable\n')] },
  })),
  { args: ['inventory', 'host-create', 'synthetic-host', '--inventory', '7'], path: 'hosts/', body: { name: 'synthetic-host', inventory: 7 } },
  { args: ['inventory', 'host-edit', '42', '--name', 'updated-host'], path: 'hosts/42/', body: { name: 'updated-host' } },
  { args: ['inventory', 'host-edit', '42', '--variables', 'variables.json'], path: 'hosts/42/',
    body: { variables: '{"ansible_password":"CANARY-host-edit"}' },
    input: { files: [upload('variables.json', '{"ansible_password":"CANARY-host-edit"}')] } },
  { args: ['inventory', 'group-create', 'Synthetic group', '--inventory', '7'], path: 'inventories/7/groups/', body: { name: 'Synthetic group' } },
  { args: ['inventory', 'group-edit', '42', '--name', 'Updated group'], path: 'groups/42/', body: { name: 'Updated group' } },
  { args: ['inventory', 'group-create', 'Synthetic group', '--inventory', '7', '--variables', '{"ansible_password":"CANARY-group-create"}'],
    path: 'inventories/7/groups/', body: { name: 'Synthetic group', variables: '{"ansible_password":"CANARY-group-create"}' } },
  { args: ['inventory', 'group-edit', '42', '--variables', 'variables.yml'], path: 'groups/42/',
    body: { variables: 'ansible_password: CANARY-group-edit\n' },
    input: { files: [upload('variables.yml', 'ansible_password: CANARY-group-edit\n')] } },
  ...['host', 'child'].flatMap(kind => ['add', 'remove'].map(operation => ({
    args: ['inventory', `group-${operation}-${kind}`, '42', `--${kind}`, '43'],
    path: `groups/42/${kind === 'host' ? 'hosts' : 'children'}/`,
    body: { id: 43, ...(operation === 'remove' ? { disassociate: true } : {}) },
  }))),
  { args: ['inventory', 'source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm'], path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm' } },
  { args: ['inventory', 'source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm', '--source-vars', '{"region":"synthetic-region"}'],
    path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm', source_vars: '{"region":"synthetic-region"}' } },
  { args: ['inventory', 'source-edit', '42', '--name', 'Updated source'], path: 'inventory_sources/42/', body: { name: 'Updated source' } },
  ...['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: ['inventory', `source-${verb}`, verb === 'create' ? 'Synthetic source' : '42', ...(verb === 'create' ? ['--inventory', '7'] : []),
      '--source', 'scm', '--source-project', '8', '--credential', '9', '--source-vars', channel === 'inline' ? '{"password":"CANARY-source-variable"}' : 'source.json',
      verb === 'create' ? '--update-on-launch' : '--no-update-on-launch'],
    path: verb === 'create' ? 'inventory_sources/' : 'inventory_sources/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic source', inventory: 7 } : {}), source: 'scm', source_project: 8, credential: 9,
      source_vars: '{"password":"CANARY-source-variable"}', update_on_launch: verb === 'create' },
    input: channel === 'upload' ? { files: [upload('source.json', '{"password":"CANARY-source-variable"}')] } : {},
  }))),
  ...['add', 'remove'].flatMap(operation => [
    { args: ['inventory', `source-credential-${operation}`, '42', '--credential', '9'], path: 'inventory_sources/42/credentials/',
      body: { id: 9, ...(operation === 'remove' ? { disassociate: true } : {}) } },
    ...['started', 'success', 'error'].map(event => ({
      args: ['inventory', `source-notification-${operation}`, '42', '--event', event, '--notification-template', '10'],
      path: `inventory_sources/42/notification_templates_${event}/`, body: { id: 10, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
  ]),
  { args: ['template', 'create', 'Synthetic template', '--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'], path: 'job_templates/', body: { name: 'Synthetic template', inventory: 7, project: 8, playbook: 'synthetic.yml' } },
  { args: ['template', 'edit', '42', '--name', 'Updated template'], path: 'job_templates/42/', body: { name: 'Updated template' } },
  ...['template', 'workflow'].flatMap(noun => ['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: [noun, verb, verb === 'create' ? 'Synthetic automation' : '42',
      ...(verb === 'create' ? noun === 'template' ? ['--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'] : ['--organization', '7'] : []),
      '--extra-vars', channel === 'inline' ? 'mode: synthetic\npassword: CANARY-template-variable\n' : 'template.yml'],
    path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/${verb === 'create' ? '' : '42/'}`,
    body: { ...(verb === 'create' ? { name: 'Synthetic automation', ...(noun === 'template'
      ? { inventory: 7, project: 8, playbook: 'synthetic.yml' } : { organization: 7 }) } : {}),
      extra_vars: '{"mode":"synthetic","password":"CANARY-template-variable"}' },
    input: channel === 'upload' ? { files: [upload('template.yml', 'mode: synthetic\npassword: CANARY-template-variable\n')] } : {},
  })))),
  ...['create', 'edit'].map(verb => ({
    args: ['workflow', `node-${verb}`, '42', '--template', '8', '--inventory', '7', '--extra-vars', 'node.json',
      '--limit', 'synthetic-host', '--scm-branch', 'synthetic', '--job-type', 'check', '--job-tags', 'connectivity', '--skip-tags', 'updates', '--verbosity', '2'],
    path: verb === 'create' ? 'workflow_job_templates/42/workflow_nodes/' : 'workflow_job_template_nodes/42/',
    body: { unified_job_template: 8, inventory: 7, extra_data: { mode: 'synthetic', password: 'CANARY-node-variable' },
      limit: 'synthetic-host', scm_branch: 'synthetic', job_type: 'check', job_tags: 'connectivity', skip_tags: 'updates', verbosity: 2 },
    input: { files: [upload('node.json', '{"mode":"synthetic","password":"CANARY-node-variable"}')] },
    preview: { input: { extra_data: '[structured input redacted, 54 bytes]' } },
  })),
  ...['template', 'workflow'].flatMap(noun => ['add', 'remove'].flatMap(operation => [
    ...['label', ...(noun === 'template' ? ['credential', 'instance-group'] : [])].map(kind => ({
      args: [noun, `${kind}-${operation}`, '42', `--${kind}`, '7'],
      path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/42/${kind.replaceAll('-', '_')}s/`,
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    ...['started', 'success', 'error', ...(noun === 'workflow' ? ['approval'] : [])].map(event => ({
      args: [noun, `notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
      path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/42/notification_templates_${event === 'approval' ? 'approvals' : event}/`,
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
  ])),
  ...['add', 'remove'].flatMap(operation => ['credential', 'label', 'instance-group'].map(kind => ({
    args: ['workflow', `node-${kind}-${operation}`, '42', `--${kind}`, '7'],
    path: `workflow_job_template_nodes/42/${kind.replaceAll('-', '_')}s/`,
    body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
  }))),
  ...['success', 'failure', 'always'].flatMap(on => ['link', 'unlink'].map(operation => ({
    args: ['workflow', `node-${operation}`, '42', '--to', '43', '--on', on],
    path: `workflow_job_template_nodes/42/${on}_nodes/`, body: { id: 43, ...(operation === 'unlink' ? { disassociate: true } : {}) },
  }))),
  { args: ['project', 'create', 'Synthetic project', '--organization', '7'], path: 'projects/', body: { name: 'Synthetic project', organization: 7 } },
  { args: ['project', 'edit', '42', '--name', 'Updated project'], path: 'projects/42/', body: { name: 'Updated project' } },
  ...['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: ['project', verb, verb === 'create' ? 'Synthetic SCM project' : '42', '--organization', '7',
      '--scm-type', 'git', '--scm-url', channel === 'inline' ? 'https://scm.example/repo?ref=main' : 'scm.txt',
      '--scm-branch', 'synthetic-branch', '--credential', '9'],
    path: verb === 'create' ? 'projects/' : 'projects/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic SCM project' } : {}), organization: 7, scm_type: 'git',
      scm_url: 'https://scm.example/repo?ref=main', scm_branch: 'synthetic-branch', credential: 9 },
    input: channel === 'upload' ? { files: [upload('scm.txt', 'https://scm.example/repo?ref=main')] } : {},
    preview: { dry_run: { payload: { organization: 7, scm_type: 'git', scm_branch: 'synthetic-branch', credential: 9,
      scm_url: '[SCM URL redacted]' } } },
  }))),
  ...['started', 'success', 'error'].map(event => ({
    args: ['project', 'notification-remove', '42', '--event', event, '--notification-template', '7'],
    path: `projects/42/notification_templates_${event}/`, body: { id: 7, disassociate: true },
  })),
  ...['create', 'edit'].flatMap(operation => [false, true].map(attachCredential => ({
    args: ['execution-environment', operation, operation === 'create' ? 'Synthetic environment' : '42',
      '--image', 'registry.example/automation/runner:stable', '--organization', '7',
      '--description', 'Synthetic runner image', '--pull', 'always', ...(attachCredential ? ['--credential', '9'] : [])],
    path: operation === 'create' ? 'execution_environments/' : 'execution_environments/42/',
    body: { ...(operation === 'create' ? { name: 'Synthetic environment' } : {}),
      image: 'registry.example/automation/runner:stable', organization: 7, description: 'Synthetic runner image', pull: 'always',
      ...(attachCredential ? { credential: 9 } : {}) },
    preview: { dry_run: { payload: { image: 'registry.example/automation/runner:stable', organization: 7,
      description: 'Synthetic runner image', pull: 'always', ...(attachCredential ? { credential: 9 } : {}) } } },
  }))),
  { args: ['schedule', 'create', 'Synthetic schedule', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY'], path: 'schedules/', body: { name: 'Synthetic schedule', unified_job_template: 7, rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY' } },
  { args: ['schedule', 'edit', '42', '--name', 'Updated schedule'], path: 'schedules/42/', body: { name: 'Updated schedule' } },
  ...['create', 'edit'].flatMap(operation => ['inline', 'upload'].map(channel => ({
    args: ['schedule', operation, operation === 'create' ? 'Synthetic schedule' : '42', '--template', '7',
      '--inventory', '8', '--limit', 'synthetic-host', '--job-tags', 'configure,verify', '--skip-tags', 'restart',
      '--extra-vars', channel === 'inline' ? '{"mode":"synthetic","password":"CANARY-schedule"}' : 'schedule.yml', '--disabled'],
    path: operation === 'create' ? 'schedules/' : 'schedules/42/',
    body: { ...(operation === 'create' ? { name: 'Synthetic schedule' } : {}), unified_job_template: 7,
      inventory: 8, limit: 'synthetic-host', job_tags: 'configure,verify', skip_tags: 'restart',
      extra_data: { mode: 'synthetic', password: 'CANARY-schedule' }, enabled: false },
    ...(channel === 'upload' ? { input: { files: [upload('schedule.yml', 'mode: synthetic\npassword: CANARY-schedule\n')] } } : {}),
  }))),
  ...[
    { operation: 'credential-add', flag: 'credential', route: 'credentials', remove: false },
    { operation: 'credential-remove', flag: 'credential', route: 'credentials', remove: true },
    { operation: 'label-remove', flag: 'label', route: 'labels', remove: true },
    { operation: 'instance-group-remove', flag: 'instance-group', route: 'instance_groups', remove: true },
  ].map(({ operation, flag, route, remove }) => ({
    args: ['schedule', operation, '42', `--${flag}`, '7'], path: `schedules/42/${route}/`,
    body: { id: 7, ...(remove ? { disassociate: true } : {}) },
  })),
  { args: ['workflow', 'create', 'Synthetic workflow', '--organization', '7'], path: 'workflow_job_templates/', body: { name: 'Synthetic workflow', organization: 7 } },
  { args: ['workflow', 'edit', '42', '--name', 'Updated workflow'], path: 'workflow_job_templates/42/', body: { name: 'Updated workflow' } },
  { args: ['workflow', 'node-create', '7', '--template', '8'], path: 'workflow_job_templates/7/workflow_nodes/', body: { unified_job_template: 8 } },
  { args: ['workflow', 'node-edit', '42', '--template', '8'], path: 'workflow_job_template_nodes/42/', body: { unified_job_template: 8 } },
  { args: ['workflow', 'node-link', '42', '--to', '7', '--on', 'success'], path: 'workflow_job_template_nodes/42/success_nodes/', body: { id: 7 } },
  { args: ['workflow', 'node-add-approval', '42', '--name', 'Synthetic approval'], path: 'workflow_job_template_nodes/42/create_approval_template/', body: { name: 'Synthetic approval' } },
  { args: ['workflow', 'node-label-add', '42', '--label', '7'], path: 'workflow_job_template_nodes/42/labels/', body: { id: 7 } },
  { args: ['workflow', 'node-instance-group-add', '42', '--instance-group', '7'], path: 'workflow_job_template_nodes/42/instance_groups/', body: { id: 7 } },
  { args: ['workflow', 'label-add', '42', '--label', '7'], path: 'workflow_job_templates/42/labels/', body: { id: 7 } },
  { args: ['template', 'label-add', '42', '--label', '7'], path: 'job_templates/42/labels/', body: { id: 7 } },
  { args: ['template', 'instance-group-add', '42', '--instance-group', '7'], path: 'job_templates/42/instance_groups/', body: { id: 7 } },
  { args: ['schedule', 'label-add', '42', '--label', '7'], path: 'schedules/42/labels/', body: { id: 7 } },
  { args: ['schedule', 'instance-group-add', '42', '--instance-group', '7'], path: 'schedules/42/instance_groups/', body: { id: 7 } },
  { args: ['inventory', 'group-add-host', '42', '--host', '7'], path: 'groups/42/hosts/', body: { id: 7 } },
  { args: ['inventory', 'group-add-child', '42', '--child', '7'], path: 'groups/42/children/', body: { id: 7 } },
  { args: ['template', 'copy', '42', '--name', 'Synthetic copy'], path: 'job_templates/42/copy/', body: { name: 'Synthetic copy' } },
  { args: ['workflow', 'copy', '42', '--name', 'Synthetic copy'], path: 'workflow_job_templates/42/copy/', body: { name: 'Synthetic copy' } },
  { args: ['template', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'job_templates/42/notification_templates_success/', body: { id: 7 } },
  { args: ['workflow', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'workflow_job_templates/42/notification_templates_success/', body: { id: 7 } },
  { args: ['project', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'projects/42/notification_templates_success/', body: { id: 7 } },
  { args: ['inventory', 'source-notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'inventory_sources/42/notification_templates_success/', body: { id: 7 } },
]

export function configurationTests(domains: string[]) {
  const cases = configurationCases.filter(({ args }) => domains.includes(args[0]))
  const behaviors = ['disabled confirmation', 'disabled preview', 'confirmation', 'preview', 'permission denial', 'mutation', 'audit', 'private output', 'input cleanup'] as const
  test.each(cases.flatMap(item => behaviors.map(behavior => ({ ...item, behavior }))))(
    'AWX $args: $behavior', async ({ args, path, body, input = {}, unconfirmed = { error: { code: 'FLAG_BLOCKED' } }, preview: expectedPreview, privateValue = 'CANARY-', behavior }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        const args = [...call.args]
        args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return { ...call, args }
      }
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 1) }
    }
    const runner = await Runner.create(join(directory, 'calls'))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/credential', headers,
        payload: { value: { origin: `https://localhost:${port}`, token: 'CANARY-awx-token' }, expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      const inspected = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
      const trusted = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
        payload: { inspectionId: inspected.json().inspectionId, mode: 'pin' } })
      expect(trusted.statusCode, trusted.body).toBe(200)
      const settings = async (nativeSettings: Record<string, boolean>) => {
        const revision = (db.prepare("SELECT revision FROM tools WHERE name = 'awx-axi'").get() as { revision: number }).revision
        const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
          payload: { enabled: true, nativeSettings, expectedRevision: revision } })
        expect(response.statusCode, response.body).toBe(200)
      }
      const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      await settings(behavior.startsWith('disabled') ? {} : { allowWrites: true })
      await send('/__ado/reset', 'POST')
      if (behavior === 'disabled confirmation' || behavior === 'disabled preview') {
        const result = await run([...args, behavior === 'disabled confirmation' ? '--confirm' : '--dry-run'])
        expect(result.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
        expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      } else if (behavior === 'confirmation') {
        expect((await run(args)).json()).toMatchObject(unconfirmed)
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      } else if (behavior === 'preview') {
        const preview = await run([...args, '--dry-run'])
        expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('dry_run') })
        if (expectedPreview) expect(decode(preview.json().stdout)).toMatchObject(expectedPreview)
        expect(preview.body).not.toContain(privateValue)
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      } else if (behavior === 'permission denial') {
        await send('/__awx/configuration-permission?enabled=false', 'POST')
        const denied = await run([...args, '--confirm'])
        expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
        expect(denied.body).not.toContain(privateValue)
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      } else {
        const written = await run([...args, '--confirm'])
        expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
        if (behavior === 'mutation') {
          const evidence = JSON.parse(await send('/__evidence'))
          expect(evidence.mutations).toBe(1)
          expect(evidence.requests).toContainEqual({ method: args[1].endsWith('edit') ? 'PATCH' : 'POST',
            path: `/api/v2/${path}`, auth: 'Bearer', canaryReceived: true, body })
        } else if (behavior === 'audit') {
          const audit = db.prepare("SELECT event, action, arguments FROM audit WHERE tool = 'awx-axi'").all()
          expect(audit).toContainEqual(expect.objectContaining({ event: 'run-terminal', action: 'write' }))
          expect(JSON.stringify(audit)).not.toContain('CANARY-awx-token')
          expect(JSON.stringify(audit)).not.toContain('CANARY-')
        } else if (behavior === 'private output') {
          expect(written.body).not.toContain(privateValue)
          expect(written.body).not.toContain('CANARY-awx-token')
        } else {
          expect(readdirSync(join(directory, 'calls'))).toEqual([])
        }
      }
    } finally { await app.close(); db.close() }
  })
}, 60_000)
}
