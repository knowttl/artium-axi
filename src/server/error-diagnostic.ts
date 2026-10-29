import { fileURLToPath } from 'node:url'
import { resolve, relative, isAbsolute, basename, dirname } from 'node:path'
import { MasterKeyMismatch } from './store/key-provider.js'

const moduleRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const applicationRoot = basename(moduleRoot) === 'dist' ? dirname(moduleRoot) : moduleRoot

// Only application/dependency code locations, errno tokens and validated key IDs may cross this diagnostic boundary.
export function errorDiagnostic(error: unknown): { errorCode?: string, frames?: string[], requiredKeyId?: string } {
  if (!(error instanceof Error)) return {}
  const code = (error as NodeJS.ErrnoException).code
  const errorCode = typeof code === 'string' && /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(code) && code.length <= 100 ? code : undefined
  const frames = (error.stack ?? '').split('\n').slice(1).flatMap(line => {
    const match = /^\s+at (?:[^()\n]+ \()?((?:file:\/\/\/|\/)[^()\s]+):(\d+):\d+\)?$/.exec(line)
    if (!match) return []
    let path: string
    try { path = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1] }
    catch { return [] }
    const location = relative(applicationRoot, resolve(path))
    if (isAbsolute(location) || !/^(?:dist|node_modules)\/[a-zA-Z0-9_@./+-]+\.[cm]?js$/.test(location) || location.split('/').includes('..')) return []
    return [`${location}:${match[2]}`]
  }).slice(0, 5)
  return { ...(errorCode ? { errorCode } : {}), ...(frames.length ? { frames } : {}),
    ...(error instanceof MasterKeyMismatch && /^[a-f0-9]{64}$/.test(error.requiredKeyId) ? { requiredKeyId: error.requiredKeyId } : {}) }
}
