import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function initializeNativeWriteLog(path: string, now = Date.now()): void {
  for (const suffix of ['.lock', '.retention']) {
    try { unlinkSync(`${path}${suffix}`) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  retainNativeWriteLog(path, now)
}

// Use the pinned tool's exclusive lock and JSONL format, keeping each intent and outcome together.
export function retainNativeWriteLog(path: string, now = Date.now()): void {
  let lock: number
  try { lock = openSync(`${path}.lock`, 'wx', 0o600) }
  catch (error) {
    if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code!)) return
    throw error
  }
  const temporary = `${path}.retention`
  let created = false
  try {
    let content: string
    try { content = readFileSync(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (content && !content.endsWith('\n')) throw new Error('Incomplete native write journal')
    const records = content.split('\n').filter(Boolean).map(line => {
      const record = JSON.parse(line) as { kind: string, intentKey: string, time: string }
      if (!['intent', 'outcome'].includes(record.kind) || !/^[a-f0-9]{64}$/.test(record.intentKey)
        || !Number.isFinite(Date.parse(record.time))) throw new Error('Invalid native write journal')
      return { line, record }
    })
    const cutoff = now - 90 * 24 * 60 * 60 * 1000
    const retained = new Set(records.filter(({ record }) => Date.parse(record.time) >= cutoff)
      .map(({ record }) => record.intentKey))
    const lines = records.filter(({ record }) => retained.has(record.intentKey)).map(({ line }) => line)
    if (lines.length === records.length) return
    const file = openSync(temporary, 'wx', 0o600)
    created = true
    try { writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : ''); fsyncSync(file) }
    finally { closeSync(file) }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    try { if (created) unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    closeSync(lock)
    unlinkSync(`${path}.lock`)
  }
}
