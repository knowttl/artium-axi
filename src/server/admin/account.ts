import type Database from 'better-sqlite3'
import type { FastifyReply } from 'fastify'
import type { BrowserSession } from '../auth/sessions.js'
import { listUserSessions } from '../auth/user-sessions.js'
import { toolProducts } from './design/status.js'
import { sessionsProps } from './session-card.js'
import { transferLimits, transferWarning, transferWarningFor } from '../../shared/api.js'
import type { Adapter } from '../adapters/types.js'
import type { AccountGuideProps, AccountProps } from '../../views/account.js'
import { accountTokens } from './delegated-tokens.js'

const hosts = [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['pi', 'Pi']] as const
const savingTools = ['hybrid-axi', 'checkpoint-axi', 'mg-axi', 'beyondtrust-axi']

export function accountRoles(db: Database.Database, current: BrowserSession): string[] {
  return (db.prepare(`SELECT DISTINCT roles.name FROM roles JOIN user_roles ON roles.id = user_roles.role_id
    WHERE user_roles.user_id = ? ORDER BY roles.name`).all(current.user_id) as { name: string }[]).map(role => role.name)
}

export function accountProps(db: Database.Database, current: BrowserSession, reply: FastifyReply, origin: string, adapters: readonly Adapter<unknown>[]): AccountProps {
  const csrf = reply.generateCsrf()
  const tools = db.prepare(`SELECT DISTINCT tools.name, tools.enabled FROM tools
    JOIN role_tools ON role_tools.tool = tools.name JOIN user_roles ON user_roles.role_id = role_tools.role_id
    WHERE user_roles.user_id = ? ORDER BY tools.name`).all(current.user_id) as { name: keyof typeof toolProducts, enabled: number }[]
  const transfers = db.prepare(`SELECT tool, artifact_type, artifact_selector, archive_bytes, archive_sha256, outcome, client_save_outcome,
    native_journal_result, EXISTS(SELECT 1 FROM audit AS delivery WHERE delivery.transfer_id = prior.transfer_id
      AND delivery.outcome = 'delivery-completed') AS delivered
    FROM audit AS prior WHERE event = 'transfer' AND user_id = ? AND NOT EXISTS
      (SELECT 1 FROM audit AS later WHERE later.transfer_id = prior.transfer_id AND later.id > prior.id)
    ORDER BY id DESC LIMIT 20`).all(current.user_id) as { tool: string, artifact_type: string, artifact_selector: string,
      archive_bytes: number | null, archive_sha256: string | null, outcome: string, client_save_outcome: string,
      native_journal_result: string | null, delivered: number }[]
  const has = (name: string) => tools.some(tool => tool.name === name)
  const sso = current.source === 'sso' ? ' --sso' : ''
  const download = `export ARTIUM_AXI_URL=${shellQuote(origin)}
curl --fail --output artium-axi.mjs "$ARTIUM_AXI_URL/cli/artium-axi.mjs" &&
curl --fail --output artium-axi.mjs.sha256 "$ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" &&
sha256sum --check artium-axi.mjs.sha256 &&
chmod 755 artium-axi.mjs`
  const signIn = `${current.source === 'sso' ? './artium-axi.mjs login --sso' : './artium-axi.mjs login --username ' + shellQuote(current.username)}
./artium-axi.mjs tools`
  const signInHelp = current.source === 'sso'
    ? 'Open the displayed /device URL in any browser, enter your terminal code, choose your sign-in provider and review the requesting IP and time. Approve only a request you started on a device you control. Choose “This wasn\'t me” for an unexpected request. Codes expire after 10 minutes; CLI access ends after 8 hours and requires a new sign-in. This works on headless and SSH hosts without enabling an identity provider device-code grant.'
    : 'Login prompts for your password without displaying it. If a temporary password must be changed, run ./artium-axi.mjs passwd, then sign in again.'
  const saved = tools.filter(tool => savingTools.includes(tool.name))
  const guide: AccountGuideProps = {
    tools: tools.map(tool => ({ mark: toolProducts[tool.name].mark, name: toolProducts[tool.name].name, available: Boolean(tool.enabled) })),
    cli: { download, signIn, signInHelp, hosts: hosts.map(([id, label]) => ({ id, label, command: `./artium-axi.mjs setup --host ${id}` })) },
    saving: saved.length ? {
      tools: saved.map(tool => toolProducts[tool.name].name).join(', '),
      paragraphs: [
        [has('hybrid-axi') || has('checkpoint-axi') ? transferWarning : transferWarningFor(has('beyondtrust-axi') ? 'policy.download' : 'mail.message.export')],
        ['Use the local CLI on a dedicated controlled Linux analysis client. The browser provides guidance and metadata only. Artifact bytes are never saved, rendered, opened or executed here. Downloads require administrator selection of the requested write operation and a configured dedicated artifact mount.'],
        ['Run ', { code: 'artium-axi download --help' }, ` for preview and explicit save commands. Choose a new absolute destination in a dedicated private directory (mode 0700), with no symlink components. Review type, exact selector, local destination, the ${transferLimits.artifactBytes / 1024 ** 2} MiB limit (50 MiB for Check Point, Graph and BeyondTrust) and exact expiry before executing. Limits are ${transferLimits.reservationsPerUser} reservation per user, ${transferLimits.reservations} globally and ${transferLimits.reservedBytes / 1024 ** 3} GiB total artifact capacity. The ten-minute deadline includes generation and retrieval. There is no resume or automatic retry.`],
        ['After preview, repeat the exact selection and destination with ', { code: '--transfer <transferId> --execute --confirm <exact-confirm>' },
          '. The CLI reports archive size, archive SHA-256 and local save outcome. Server delivery completion is separate from upstream success and verified saving. Missing verified-save receipt remains unconfirmed. Absolute local paths are not stored by the server.'],
      ],
      sections: [
        ...has('hybrid-axi') ? [{ title: 'Hybrid Analysis archive saving', before: [],
          command: `artium-axi download --operation report-download-bin --selector <report-id> --type bin --destination /controlled/artifacts/new-archive.bin${sso}`,
          after: [['HTTP 403 with KEY_LEVEL_RESTRICTED requires vetted-account download access. PERMISSION_DENIED with unknown key level does not prove restriction. Administrator write settings cannot grant upstream entitlement. Never retry another key or route.']] }] : [],
        ...has('checkpoint-axi') ? [{ title: 'Check Point email and attachment saving',
          before: [['Select email.download (type email or original), attachment.download (type attachment; selector entity-id/attachment-id) or attachment.download-all (type zip). Each requires its own administrator selection. Check Point uses host-owned confirmation and evidence, a 50 MiB cap, mandatory upstream SHA-256 and independent host byte verification. It has no native download journal. Scope and email/ZIP hash availability remain uncommissioned; ZIP responses may be partial.']],
          command: `artium-axi download --operation email.download --selector <entity-id> --type email --destination /controlled/artifacts/new-message.eml${sso}`, after: [] }] : [],
        ...has('mg-axi') ? [{ title: 'Microsoft Graph mail saving',
          before: [[`${transferWarningFor('mail.message.export')} Select mail.message.export with type mime and selector mailbox/message-id, or mail.attachment.save with type attachment and selector mailbox/message-id/attachment-id. Each requires the mail pack, application sign-in, its exact administrator-selected operation and scoped Exchange Application Mail.Read. Host-owned confirmation binds the destination and selection; native journal and SHA-256 are verified before retrieval. Audit selectors are hashed.`]],
          command: `artium-axi download --operation mail.message.export --selector <mailbox>/<message-id> --type mime --destination /controlled/artifacts/new-message.eml${sso}`, after: [] }] : [],
        ...has('beyondtrust-axi') ? [{ title: 'BeyondTrust endpoint content saving',
          before: [['Select computer.log.download, policy.download or policy.revision.download with type content and a UUID selector; api-definition.download uses type yaml and selector api. Each operation requires administrator selection. Host-owned confirmation binds the destination and selection; native SHA-256 and bytes are independently verified, with no native download journal. Maximum 50 MiB; save only.']],
          command: null, after: [] }] : [],
      ],
      transfers: transfers.map(row => ({ tool: row.tool, type: row.artifact_type, selector: row.artifact_selector, bytes: String(row.archive_bytes ?? 'Unknown'),
        sha256: row.archive_sha256 ?? 'Unknown', native: ['checkpoint-axi', 'beyondtrust-axi'].includes(row.tool) ? 'Host-owned evidence; no native journal' : row.native_journal_result ?? 'Unknown',
        delivered: row.delivered ? 'Completed' : 'Unconfirmed', outcome: row.outcome, receipt: row.client_save_outcome })),
    } : null,
  }
  return { csrf, guide, tokens: accountTokens(db, current, adapters), sessions: sessionsProps(csrf, '/v1/account/sessions', listUserSessions(db, current.user_id, current.family_id).sessions) }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
