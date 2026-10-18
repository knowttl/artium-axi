import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const root = process.cwd()
let matches = 0
let files = 0
let terms = []

function safe(value) {
  return JSON.stringify(terms.some(term => value.search(term) !== -1) ? '[redacted]' : value)
}

function scan(label, content) {
  const lines = content.split('\n')
  for (const [index, term] of terms.entries()) {
    for (const [line, text] of lines.entries()) {
      for (const match of text.matchAll(term)) {
        console.log(`match: ${safe(label)}:${line + 1}:${match.index + 1} term=${index + 1}`)
        matches++
      }
    }
  }
}

function walk(path) {
  const label = relative(root, path) || '.'
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`symlink requires a regular-file candidate: ${safe(label)}`)
  scan(`path ${label}`, label)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      // Repository metadata and installed dependencies are not candidate assets.
      if (name === '.git' || name === 'node_modules') continue
      walk(join(path, name))
    }
  } else if (stat.isFile()) {
    const content = readFileSync(path)
    if ((content[0] === 0xff && content[1] === 0xfe)
      || (content[0] === 0xfe && content[1] === 0xff)
      || (content[0] === 0x00 && content[1] === 0x00 && content[2] === 0xfe && content[3] === 0xff)) {
      throw new Error(`unsupported text encoding; convert to UTF-8: ${safe(label)}`)
    }
    scan(label, content.toString('utf8'))
    files++
  } else {
    throw new Error(`unsupported candidate file: ${safe(label)}`)
  }
}

try {
  const assets = process.argv.slice(2)
  if (assets.includes('--help')) {
    console.log('usage: pnpm hygiene:check [asset-path ...]\nSet ARTIUM_AXI_HYGIENE_DENY_LIST_FILE to an external one-term-per-line list.\nScans the current candidate tree, supplied assets and all HEAD commit messages.')
  } else {
    if (assets.some(asset => asset.startsWith('-'))) throw new Error('unknown option; use --help')
    const listPath = process.env.ARTIUM_AXI_HYGIENE_DENY_LIST_FILE
    if (!listPath) throw new Error('set ARTIUM_AXI_HYGIENE_DENY_LIST_FILE to the private deny-list path outside the candidate tree')
    const listRelative = relative(realpathSync(root), realpathSync(listPath))
    if (!listRelative.startsWith(`..${sep}`) && !isAbsolute(listRelative)) {
      throw new Error('deny list must stay outside the candidate tree')
    }
    const list = readFileSync(listPath)
    // Unicode simple case folding is context-independent and preserves original match offsets.
    for (const term of list.toString('utf8').split(/\r?\n/).map(term => term.trim()).filter(Boolean)) {
      if (!terms.some(existing => new RegExp(`^(?:${existing.source})$`, 'iu').test(term))) {
        terms.push(new RegExp(RegExp.escape(term), 'giu'))
      }
    }
    if (!terms.length) throw new Error('deny list must contain at least one nonempty term')
    for (const asset of assets) {
      const assetRelative = relative(realpathSync(asset), realpathSync(listPath))
      if (!assetRelative.startsWith(`..${sep}`) && !isAbsolute(assetRelative)) {
        throw new Error('deny list must stay outside supplied assets')
      }
    }
    walk(root)
    for (const asset of assets) walk(resolve(asset))
    const history = spawnSync('git', ['log', 'HEAD', '--format=%H%x00%B%x00'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    if (history.error || history.status !== 0) throw new Error('cannot read HEAD commit messages; run inside a repository with a committed HEAD')
    const records = history.stdout.split('\0')
    for (let index = 0; index + 1 < records.length; index += 2) {
      scan(`commit ${records[index].trim()}`, records[index + 1])
    }
    console.log(`hygiene: ${matches ? 'fail' : 'pass'} files=${files} matches=${matches} list_sha256=${createHash('sha256').update(list).digest('hex')}`)
    process.exitCode = matches ? 1 : 0
  }
} catch (error) {
  // Filesystem errors can contain private paths, so never relay their raw messages.
  const message = error.code ? 'cannot read candidate, asset or deny list; check paths and permissions' : error.message
  console.log(`error: ${message}`)
  process.exitCode = 1
}
