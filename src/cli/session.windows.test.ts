import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { SessionStore } from './session.js'

test.skipIf(process.platform !== 'win32')('security PowerShell 5.1 persists sessions with protected directory and file ACLs', () => {
  const directory = mkdtempSync(join(process.cwd(), 'artium-session-'))
  try {
    const store = new SessionStore('https://server.test', join(directory, "synthetic ' session", 'session.json'))
    const session = { status: 'authenticated' as const, accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh',
      accessExpiresAt: 3600_000, familyExpiresAt: 43200_000 }
    const stored = store.write(session)
    expect(store.read()).toEqual(stored)
    const replacement = store.write({ ...session, accessToken: 'CANARY-replacement' })
    expect(readdirSync(store.directory)).toEqual(['session.json'])

    const script = `$ErrorActionPreference='Stop'; ` +
      `$acls=@(foreach ($path in @($env:ARTIUM_TEST_DIRECTORY,$env:ARTIUM_TEST_FILE)) { ` +
      `$acl=Get-Acl -LiteralPath $path; ` +
      `@{ protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { ` +
      `@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; type=[int]$_.AccessControlType; ` +
      `inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags } }) } }); ` +
      `@{ version=$PSVersionTable.PSVersion.ToString(); user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; acls=$acls } | ConvertTo-Json -Depth 5 -Compress`
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', env: { ...process.env, ARTIUM_TEST_DIRECTORY: store.directory, ARTIUM_TEST_FILE: store.file },
    })) as { version: string; user: string; acls: { protected: boolean; rules: { sid: string }[] }[] }
    expect(result.version.split('.').slice(0, 2)).toEqual(['5', '1'])
    const sids = [result.user, 'S-1-5-18', 'S-1-5-32-544'].sort()
    expect(result.acls.map(acl => ({ ...acl, rules: acl.rules.sort((a, b) => a.sid.localeCompare(b.sid)) }))).toEqual(
      [3, 0].map(inheritance => ({ protected: true, rules: sids.map(sid => ({
        sid, rights: 2032127, type: 0, inherited: false, inheritance, propagation: 0,
      })) })),
    )
    expect(store.read()).toEqual(replacement)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
