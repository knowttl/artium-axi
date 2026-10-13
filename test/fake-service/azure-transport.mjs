const send = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url = new URL(input)
  if (url.origin !== 'https://management.azure.com') throw new Error('Unexpected fake Azure origin')
  const target = new URL(url.pathname + url.search, process.env.ARTIUM_TEST_AZURE_ORIGIN)
  return send(target, { ...options, headers: { ...options?.headers, host: url.host } })
}
