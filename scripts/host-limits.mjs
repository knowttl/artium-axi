import { spawnSync } from 'node:child_process'

let limits
function daemonLimits() {
  if (!limits) {
    const result = spawnSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' })
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
    const info = JSON.parse(result.stdout)
    if (!Number.isSafeInteger(info.NCPU) || info.NCPU < 1 || !Number.isSafeInteger(info.MemTotal) || info.MemTotal < 2 ** 20) throw new Error('Invalid Docker daemon resource limits')
    limits = info
  }
  return limits
}

export const cpuLimit = requested => String(Math.min(requested, daemonLimits().NCPU))

export const memoryLimit = requestedMib => `${Math.min(requestedMib, Math.floor(daemonLimits().MemTotal / 2 ** 20))}m`
