import { chmodSync, existsSync, mkdirSync, openSync, closeSync, fchmodSync, readFileSync, renameSync, rmSync, statSync, fsyncSync, writeFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loginResponseSchema } from '../shared/api.js'
import type { LoginResponse } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'

export type StoredSession = LoginResponse & { loginGeneration: string }

export function sessionPath(platform = process.platform, environment = process.env, home = homedir()) {
  const paths = platform === 'win32' ? win32 : { join }
  const base = platform === 'win32' ? environment.APPDATA : environment.XDG_CONFIG_HOME || join(home, '.config')
  if (!base) throw new ArtiumError('CLIENT_CONFIG_INVALID', undefined, 'Set APPDATA to your writable roaming configuration folder, then sign in again.')
  return paths.join(base, 'artium-axi', 'session.json')
}

export function clientConfigPath(platform = process.platform, environment = process.env, home = homedir()) {
  return sessionPath(platform, environment, home).replace(/session\.json$/, 'config.json')
}

export function readClientConfig(environment = process.env) {
  try {
    return z.object({ serverUrl: z.string(), caFile: z.string().optional() })
      .parse(JSON.parse(readFileSync(clientConfigPath(process.platform, environment), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('CLIENT_CONFIG_INVALID')
  }
}

export function restrictWindowsAcl(path: string, directory: boolean) {
  const script = `$ErrorActionPreference='Stop'; $path=$env:ARTIUM_AXI_SESSION_ACL_PATH; $directory=$env:ARTIUM_AXI_SESSION_ACL_KIND -eq 'directory'; ` +
    `$acl=if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }; ` +
    `$acl.SetAccessRuleProtection($true,$false); $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$inherit=if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }; ` +
    `foreach ($sid in @($user,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) { ` +
    `$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')) }; ` +
    `$item=if ($directory) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }; ` +
    `$item.SetAccessControl($acl)`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'ignore', env: { ...process.env, ARTIUM_AXI_SESSION_ACL_PATH: path, ARTIUM_AXI_SESSION_ACL_KIND: directory ? 'directory' : 'file' },
  })
}

export class SessionStore {
  readonly directory: string
  constructor(private readonly serverUrl: string, readonly file = sessionPath(),
    private readonly platform = process.platform, private readonly acl = restrictWindowsAcl) {
    this.directory = dirname(file)
  }

  private secureDirectory() {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (this.platform === 'win32') this.acl(this.directory, true)
      else chmodSync(this.directory, 0o700)
    } catch { throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE') }
  }

  read(): StoredSession | undefined {
    try {
      if (!existsSync(this.file)) return undefined
      if (this.platform === 'win32') this.acl(this.file, false)
      const stat = statSync(this.file)
      if (!stat.isFile() || (this.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || (statSync(this.directory).mode & 0o777) !== 0o700))) throw new Error()
      const { serverUrl, loginGeneration, ...tokens } = JSON.parse(readFileSync(this.file, 'utf8'))
      if (serverUrl !== this.serverUrl) throw new ArtiumError('SESSION_SERVER_MISMATCH')
      return { ...loginResponseSchema.parse(tokens), loginGeneration: z.uuid().parse(loginGeneration) }
    } catch (error) {
      if (error instanceof ArtiumError) throw error
      throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE')
    }
  }

  write(session: LoginResponse, loginGeneration: string = randomUUID()): StoredSession {
    this.secureDirectory()
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      const stored = { ...loginResponseSchema.parse(session), loginGeneration: z.uuid().parse(loginGeneration) }
      const file = openSync(temporary, 'wx', 0o600)
      try {
        if (this.platform === 'win32') this.acl(temporary, false)
        else fchmodSync(file, 0o600)
        writeFileSync(file, JSON.stringify({ serverUrl: this.serverUrl, ...stored }))
        fsyncSync(file)
      } finally { closeSync(file) }
      renameSync(temporary, this.file)
      return stored
    } catch { throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE') }
    finally { rmSync(temporary, { force: true }) }
  }

  writeClientConfig(caFile?: string) {
    this.secureDirectory()
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      const file = openSync(temporary, 'wx', 0o600)
      try {
        if (this.platform === 'win32') this.acl(temporary, false)
        else fchmodSync(file, 0o600)
        writeFileSync(file, JSON.stringify({ serverUrl: this.serverUrl, caFile }))
        fsyncSync(file)
      } finally { closeSync(file) }
      renameSync(temporary, join(this.directory, 'config.json'))
    } catch { throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE') }
    finally { rmSync(temporary, { force: true }) }
  }

  remove() {
    try { rmSync(this.file, { force: true }) }
    catch { throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE') }
  }

  async locked<T>(action: () => Promise<T>): Promise<T> {
    this.secureDirectory()
    const lock = join(this.directory, 'session.lock')
    const deadline = Date.now() + 100_000
    while (true) {
      // Watch before attempting acquisition so a release cannot be missed.
      const watcher = watch(this.directory)
      let timer: NodeJS.Timeout | undefined
      const changed = new Promise<void>((resolve, reject) => {
        watcher.once('change', () => resolve())
        watcher.once('error', () => reject(new ArtiumError('SESSION_STORAGE_UNAVAILABLE')))
        timer = setTimeout(() => reject(new ArtiumError('SESSION_BUSY')), Math.max(0, deadline - Date.now()))
      })
      try {
        try { mkdirSync(lock, { mode: 0o700 }) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE')
          await changed
          continue
        }
      } finally { watcher.close(); clearTimeout(timer) }
      try { return await action() }
      finally { rmSync(lock, { recursive: true }) }
    }
  }
}
