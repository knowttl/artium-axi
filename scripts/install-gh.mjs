import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, copyFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned gh image supports linux/amd64 only')
const pin = JSON.parse(await readFile('/opt/tools/gh-source.json', 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'gh-release-'))
try {
  const response = await fetch(pin.url)
  if (!response.ok) throw new Error('Cannot download pinned gh release')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('gh release checksum mismatch')
  const archive = join(directory, 'gh.tar.gz')
  await writeFile(archive, bytes)
  execFileSync('tar', ['-xzf', archive, '-C', directory, `gh_${pin.version}_linux_amd64/bin/gh`])
  await copyFile(join(directory, `gh_${pin.version}_linux_amd64/bin/gh`), '/usr/local/bin/gh')
  await chmod('/usr/local/bin/gh', 0o755)
  const environment = execFileSync('/usr/local/bin/gh', ['help', 'environment'], { encoding: 'utf8' })
  if (!environment.includes('GH_TELEMETRY')) throw new Error('Review gh telemetry controls before repinning')
} finally { await rm(directory, { recursive: true, force: true }) }
