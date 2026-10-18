import { executeArgv } from '../../tools/node_modules/@knowttl/mg-axi/dist/cli.js'

const send = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url = new URL(input)
  if (url.origin !== 'https://graph.microsoft.com') throw new Error('Unexpected fake Graph origin')
  return send(new URL(url.pathname + url.search, process.env.ARTIUM_TEST_GRAPH_ORIGIN), options)
}
try {
  const result = await executeArgv(process.argv.slice(2), { application: {
    async credential(profile) {
      return { token: 'CANARY-graph-token', tenantId: profile.tenantId, clientId: profile.clientId,
        mode: 'application', cloud: 'commercial' }
    },
  } })
  console.log(JSON.stringify(result))
} catch {
  process.exitCode = 1
}
