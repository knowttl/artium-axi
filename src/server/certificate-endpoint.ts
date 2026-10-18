export function certificateEndpoint(value: string | URL) {
  const endpoint = new URL(value)
  const hostname = endpoint.hostname.toLowerCase()
  const port = Number(endpoint.port || (endpoint.protocol === 'ldaps:' ? 636 : endpoint.protocol === 'ldap:' ? 389 : 443))
  return { hostname: hostname.replace(/^\[|\]$/g, ''), port,
    href: new URL(`${endpoint.protocol}//${hostname}:${port}/`).href }
}
