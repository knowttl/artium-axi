import { constants } from 'node:os'
import { getSystemErrorMap } from 'node:util'

export const transportCodes = [...new Set([...Object.keys(constants.errno), ...[...getSystemErrorMap().values()].map(([code]) => code)])]
