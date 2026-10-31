import { appendFileSync } from 'node:fs'

const result = { writes: process.env.ADO_AXI_WRITES ?? null }
appendFileSync(process.env.ARTIUM_TEST_ADO_RECORD, JSON.stringify(result) + '\n')
console.log(JSON.stringify(result))
