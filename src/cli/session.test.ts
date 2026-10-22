import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SessionStore, sessionPath, restrictWindowsAcl } from './session.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

let directory: string
const url = 'https://server.test'
const session = { status: 'authenticated' as const, accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh',
  accessExpiresAt: 3600_000, familyExpiresAt: 43200_000 }
let store: SessionStore
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-session-'))
  store = new SessionStore(url, join(directory, 'artium-axi', 'session.json'), 'linux')
})
afterEach(() => { vi.resetAllMocks(); rmSync(directory, { recursive: true, force: true }) })

test.each([false, true])('Windows emits a protected .NET ACL script (directory=%s)', isDirectory => {
  const path = join(directory, "synthetic ' session")
  restrictWindowsAcl(path, isDirectory)
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!
  expect(command).toBe('powershell.exe')
  expect(args?.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(options).toMatchObject({ stdio: 'ignore', env: {
    ARTIUM_AXI_SESSION_ACL_PATH: path, ARTIUM_AXI_SESSION_ACL_KIND: isDirectory ? 'directory' : 'file',
  } })
  const script = Buffer.from(args![3]!, 'base64').toString('utf16le')
  expect(script).toContain("$ErrorActionPreference='Stop'")
  expect(script).toContain('$path=$env:ARTIUM_AXI_SESSION_ACL_PATH')
  expect(script).toContain("$directory=$env:ARTIUM_AXI_SESSION_ACL_KIND -eq 'directory'")
  expect(script).toContain('$acl=if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }')
  expect(script).toContain('$acl.SetAccessRuleProtection($true,$false)')
  expect(script).toContain('$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User')
  expect(script).toContain("foreach ($sid in @($user,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')))")
  expect(script.match(/\.AddAccessRule\(/g)).toHaveLength(1)
  expect(script).toContain("[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')")
  expect(script).toContain("$inherit=if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }")
  expect(script).toContain('$item=if ($directory) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }; $item.SetAccessControl($acl)')
  expect(script).not.toMatch(/Set-Acl/i)
})

test.each([true, false])('Windows ACL script failure maps to storage unavailable (directory=%s)', failDirectory => {
  vi.mocked(execFileSync).mockImplementation((_command, _args, options) => {
    if ((options?.env?.ARTIUM_AXI_SESSION_ACL_KIND === 'directory') === failDirectory) throw new Error('synthetic script failure')
    return Buffer.alloc(0)
  })
  const windows = new SessionStore(url, store.file, 'win32')
  expect(() => windows.write(session)).toThrowError(expect.objectContaining({ code: 'SESSION_STORAGE_UNAVAILABLE' }))
  expect(readdirSync(windows.directory)).toEqual([])
})

test.each([
  ['linux', {}, '/synthetic/home', '/synthetic/home/.config/artium-axi/session.json'],
  ['darwin', { XDG_CONFIG_HOME: '/synthetic/config' }, '/synthetic/home', '/synthetic/config/artium-axi/session.json'],
  ['win32', { APPDATA: 'C:\\Synthetic\\Config', XDG_CONFIG_HOME: 'ignored' }, 'C:\\Synthetic', 'C:\\Synthetic\\Config\\artium-axi\\session.json'],
] as const)('selects the %s configuration path', (platform, environment, home, expected) => {
  expect(sessionPath(platform, environment, home)).toBe(expected)
})

test('Windows requires the roaming configuration folder', () => {
  expect(() => sessionPath('win32', {}, 'C:\\Synthetic')).toThrowError(expect.objectContaining({ code: 'CLIENT_CONFIG_INVALID' }))
})

test('security atomic replacement keeps owner-only modes and no temporary files', () => {
  store.write(session)
  expect(statSync(store.directory).mode & 0o777).toBe(0o700)
  expect(statSync(store.file).mode & 0o777).toBe(0o600)
  const originalInode = statSync(store.file).ino
  store.write({ ...session, accessToken: 'CANARY-replacement' })
  expect(statSync(store.file).ino).not.toBe(originalInode)
  expect(store.read()).toMatchObject({ ...session, accessToken: 'CANARY-replacement', loginGeneration: expect.any(String) })
  expect(readdirSync(store.directory)).toEqual(['session.json'])
})

test('security tokens cannot be loaded for another server', () => {
  store.write(session)
  expect(() => new SessionStore('https://another.test', store.file, 'linux').read())
    .toThrowError(expect.objectContaining({ code: 'SESSION_SERVER_MISMATCH' }))
})

test.each(['file', 'directory'])('security broadly readable session %s fails closed', target => {
  store.write(session)
  chmodSync(target === 'file' ? store.file : store.directory, target === 'file' ? 0o644 : 0o755)
  expect(() => store.read()).toThrowError(expect.objectContaining({ code: 'SESSION_STORAGE_UNAVAILABLE' }))
})

test('security Windows establishes directory and file ACLs before writing tokens', () => {
  const acl = vi.fn((path: string, isDirectory: boolean) => {
    if (!isDirectory) expect(readFileSync(path, 'utf8')).toBe('')
  })
  const windows = new SessionStore(url, store.file, 'win32', acl)
  const stored = windows.write(session)
  expect(acl.mock.calls.map(call => call[1])).toEqual([true, false])
  expect(JSON.parse(readFileSync(windows.file, 'utf8'))).toEqual({ serverUrl: url, ...stored })
})

test.each(['directory', 'file'])('security Windows %s ACL failure leaves existing tokens intact', failure => {
  const windows = new SessionStore(url, store.file, 'win32', () => {})
  windows.write(session)
  const acl = (path: string, isDirectory: boolean) => {
    if ((failure === 'directory') === isDirectory) throw new Error('synthetic ACL refusal')
  }
  const failed = new SessionStore(url, store.file, 'win32', acl)
  expect(() => failed.write({ ...session, accessToken: 'CANARY-replacement' }))
    .toThrowError(expect.objectContaining({ code: 'SESSION_STORAGE_UNAVAILABLE' }))
  expect(JSON.parse(readFileSync(windows.file, 'utf8')).accessToken).toBe(session.accessToken)
  expect(readdirSync(windows.directory)).toEqual(['session.json'])
})

test('a failed action releases the refresh lock for another caller', async () => {
  await expect(store.locked(async () => { throw new Error('synthetic failure') })).rejects.toThrow('synthetic failure')
  await expect(store.locked(async () => 'released')).resolves.toBe('released')
  expect(readdirSync(store.directory)).toEqual([])
})
