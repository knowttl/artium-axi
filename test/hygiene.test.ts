import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = join(root, 'scripts', 'hygiene-check.mjs')

function fixture(run: (directory: string, list: string, candidate: string) => void) {
  const directory = mkdtempSync(join(root, '.tmp-hygiene-'))
  const candidate = join(directory, 'candidate')
  const list = join(directory, 'deny.txt')
  mkdirSync(candidate)
  writeFileSync(list, 'SYNTHETIC-RESTRICTED\n')
  try {
    spawnSync('git', ['init', '-q', candidate])
    spawnSync('git', ['-C', candidate, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial synthetic candidate'])
    run(directory, list, candidate)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function check(candidate: string, list?: string, assets: string[] = []) {
  const env = { ...process.env }
  delete env.ARTIUM_AXI_HYGIENE_DENY_LIST_FILE
  if (list) env.ARTIUM_AXI_HYGIENE_DENY_LIST_FILE = list
  return spawnSync(process.execPath, [script, ...assets], { cwd: candidate, env, encoding: 'utf8' })
}

test('security hygiene fails clearly when the private list is unset', () => {
  fixture((_directory, _list, candidate) => {
    const result = check(candidate)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('set ARTIUM_AXI_HYGIENE_DENY_LIST_FILE')
  })
})

test('security hygiene passes a clean candidate and reports only the list hash', () => {
  fixture((_directory, list, candidate) => {
    writeFileSync(join(candidate, 'clean.txt'), 'generic sample\n')
    const result = check(candidate, list)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/hygiene: pass files=1 matches=0 list_sha256=[a-f0-9]{64}/)
    expect(result.stdout).not.toContain('SYNTHETIC-RESTRICTED')
  })
})

test.each(['existing.txt', 'untracked.txt', 'dist/bundle.mjs.map', 'build.log'])('security hygiene catches whole-tree content in %s', name => {
  fixture((_directory, list, candidate) => {
    mkdirSync(join(candidate, 'dist'))
    writeFileSync(join(candidate, name), 'safe\nprefix synthetic-restricted private context\n')
    const result = check(candidate, list)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`${JSON.stringify(name)}:2:8 term=1`)
    expect(result.stdout).not.toContain('private context')
    expect(result.stdout).not.toContain('synthetic-restricted')
  })
})

test('security hygiene catches external release assets', () => {
  fixture((directory, list, candidate) => {
    const asset = join(directory, 'release.txt')
    writeFileSync(asset, 'SYNTHETIC-RESTRICTED')
    expect(check(candidate, list, [asset]).status).toBe(1)
  })
})

const unsupportedText = [
  ['UTF-16LE', Buffer.from('\ufeffSYNTHETIC-RESTRICTED', 'utf16le')],
  ['UTF-16BE', Buffer.from('\ufeffSYNTHETIC-RESTRICTED', 'utf16le').swap16()],
  ['UTF-32LE', Buffer.from('fffe000073000000', 'hex')],
  ['UTF-32BE', Buffer.from('0000feff00000073', 'hex')],
] as const

test.each(unsupportedText)('security hygiene rejects BOM-marked %s candidate logs', (_encoding, content) => {
  fixture((_directory, list, candidate) => {
    writeFileSync(join(candidate, 'build.log'), content)
    const result = check(candidate, list)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported text encoding')
    expect(result.stdout).not.toContain('hygiene: pass')
  })
})

test.each(unsupportedText)('security hygiene rejects BOM-marked %s release logs', (_encoding, content) => {
  fixture((directory, list, candidate) => {
    const asset = join(directory, 'build.log')
    writeFileSync(asset, content)
    const result = check(candidate, list, [asset])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported text encoding')
    expect(result.stdout).not.toContain('hygiene: pass')
  })
})

test('security hygiene checks committed messages without printing their contents', () => {
  fixture((_directory, list, candidate) => {
    spawnSync('git', ['-C', candidate, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'SYNTHETIC-RESTRICTED private narrative'])
    const result = check(candidate, list)
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/match: "commit [a-f0-9]{40}":1:1 term=1/)
    expect(result.stdout).not.toContain('private narrative')
  })
})

test('security hygiene refuses an empty deny list', () => {
  fixture((_directory, list, candidate) => {
    writeFileSync(list, '\n')
    expect(check(candidate, list).status).toBe(1)
  })
})

test('security hygiene fails when the deny list cannot be read', () => {
  fixture((directory, _list, candidate) => {
    expect(check(candidate, join(directory, 'missing.txt')).status).toBe(1)
  })
})

test('security hygiene refuses assets containing the private list', () => {
  fixture((directory, list, candidate) => {
    expect(check(candidate, list, [directory]).stdout).toContain('deny list must stay outside supplied assets')
  })
})

test('security hygiene redacts restricted file names', () => {
  fixture((_directory, list, candidate) => {
    writeFileSync(join(candidate, 'SYNTHETIC-RESTRICTED.txt'), 'generic')
    const result = check(candidate, list)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('"[redacted]"')
    expect(result.stdout).not.toContain('SYNTHETIC-RESTRICTED')
  })
})

test.each(['candidate', 'release'])('security hygiene conceals Unicode matches in %s paths', location => {
  fixture((directory, list, candidate) => {
    const release = join(directory, 'release')
    mkdirSync(release)
    writeFileSync(list, 'İ-SYNTHETIC-TENANT\n')
    writeFileSync(join(directory, location, 'İ-SYNTHETIC-TENANT.txt'), 'generic')
    const result = check(candidate, list, [release])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('match: "[redacted]"')
    expect(result.stdout).not.toContain('İ-SYNTHETIC-TENANT')
    expect(result.stdout).not.toContain('i\u0307-synthetic-tenant')
  })
})

test.each(['candidate', 'release'])('security hygiene conceals Unicode %s symlink errors', location => {
  fixture((directory, list, candidate) => {
    const release = join(directory, 'release')
    mkdirSync(release)
    writeFileSync(list, 'İ-SYNTHETIC-TENANT\n')
    symlinkSync(list, join(directory, location, 'İ-SYNTHETIC-TENANT.txt'))
    const result = check(candidate, list, [release])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('symlink requires a regular-file candidate: "[redacted]"')
    expect(result.stdout).not.toContain('İ-SYNTHETIC-TENANT')
    expect(result.stdout).not.toContain('i\u0307-synthetic-tenant')
  })
})

test.each(['candidate', 'release'])('security hygiene conceals Unicode %s encoding errors', location => {
  fixture((directory, list, candidate) => {
    const release = join(directory, 'release')
    mkdirSync(release)
    writeFileSync(list, 'İ-SYNTHETIC-TENANT\n')
    writeFileSync(join(directory, location, 'İ-SYNTHETIC-TENANT.txt'), Buffer.from('\ufeffgeneric', 'utf16le'))
    const result = check(candidate, list, [release])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported text encoding; convert to UTF-8: "[redacted]"')
    expect(result.stdout).not.toContain('İ-SYNTHETIC-TENANT')
    expect(result.stdout).not.toContain('i\u0307-synthetic-tenant')
  })
})

test('security hygiene refuses a deny list copied into the candidate', () => {
  fixture((_directory, _list, candidate) => {
    const list = join(candidate, 'deny.txt')
    writeFileSync(list, 'SYNTHETIC-RESTRICTED')
    expect(check(candidate, list).stdout).toContain('deny list must stay outside')
  })
})

test('security hygiene refuses symlinks instead of skipping their contents', () => {
  fixture((directory, list, candidate) => {
    const target = join(directory, 'target.txt')
    writeFileSync(target, 'SYNTHETIC-RESTRICTED')
    symlinkSync(target, join(candidate, 'linked.txt'))
    expect(check(candidate, list).status).toBe(1)
  })
})
