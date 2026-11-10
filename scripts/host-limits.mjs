import { availableParallelism, totalmem } from 'node:os'

export const cpuLimit = requested => String(Math.min(requested, availableParallelism()))

export const memoryLimit = requestedMib => `${Math.min(requestedMib, Math.floor(totalmem() / 2 ** 20))}m`
