export interface ConfirmationRoute {
  tier: 2 | 3
  native?: readonly string[]
}

export const confirmationRoutes: Readonly<Record<string, ConfirmationRoute>> = {
  'POST /v1/account/sessions/revoke': { tier: 2, native: [] },
  'POST /v1/account/sessions/:sessionId/revoke': { tier: 2, native: [] },
  'POST /v1/account/tokens/:id/revoke': { tier: 2, native: [] },
  'POST /v1/admin/tokens/:id/revoke': { tier: 2, native: [] },
  'POST /v1/admin/tokens/revoke-all': { tier: 2, native: [] },
  'POST /v1/admin/users/:id/sessions/revoke': { tier: 2, native: [] },
  'POST /v1/admin/users/:id/sessions/:sessionId/revoke': { tier: 2, native: [] },
  'POST /v1/admin/users/:id/unlock': { tier: 2, native: [] },
  'POST /v1/admin/sso/role-rules': { tier: 2, native: ['providerId', 'claim', 'value', 'roleId'] },
  'POST /v1/admin/users': { tier: 2 },
  'POST /v1/admin/users/:id/archive': { tier: 3 },
  'POST /v1/admin/users/:id/password-reset': { tier: 2 },
  'POST /v1/admin/sso/providers': { tier: 2 },
  'POST /v1/admin/sso/invitations': { tier: 2 },
  'POST /v1/admin/sso/invitations/:id/resend': { tier: 2 },
  'POST /v1/admin/sso/invitations/:id/revoke': { tier: 2 },
  'POST /v1/admin/tools/gh-axi/device': { tier: 2 },
  'POST /v1/admin/tools/:tool/instances': { tier: 2 },
  'POST /v1/admin/ssh/credential': { tier: 2 },
  'POST /v1/admin/ssh/hosts': { tier: 2 },
  'POST /v1/admin/ssh/binding': { tier: 2 },
  'POST /v1/admin/ssh/grant': { tier: 2 },
  'POST /v1/admin/ssh/credential-delete': { tier: 3 },
  'POST /v1/admin/ssh/host-delete': { tier: 3 },
  'PUT /v1/admin/tools/awx-axi/origin': { tier: 2 },
  'PUT /v1/admin/tools/:tool/user-grants': { tier: 2 },
  'PUT /v1/admin/tools/:tool/raw-api/routes': { tier: 2 },
  'PUT /v1/admin/users/:id/roles': { tier: 2 },
  'PUT /v1/admin/roles/:id/tools': { tier: 2 },
  'PUT /v1/admin/roles/:id/tools/:tool/raw-api': { tier: 2 },
  'PUT /v1/admin/roles/:id/tools/:tool/instances': { tier: 2 },
  'PATCH /v1/admin/token-settings': { tier: 2 },
  'PATCH /v1/admin/users/:id': { tier: 2 },
  'PATCH /v1/admin/sso/providers/:id': { tier: 2 },
  'PATCH /v1/admin/sso/providers/:id/activation': { tier: 2 },
  'PATCH /v1/admin/sso/providers/:id/credential': { tier: 2 },
  'PATCH /v1/admin/sso/role-rules/:id': { tier: 2 },
  'PATCH /v1/admin/tools/:tool': { tier: 2 },
  'PATCH /v1/admin/tools/:tool/credential': { tier: 2 },
  'PATCH /v1/admin/tools/:tool/write-access': { tier: 2 },
  'PATCH /v1/admin/tools/:tool/raw-api': { tier: 2 },
  'PATCH /v1/admin/tools/:tool/instances/:name': { tier: 2 },
  'PATCH /v1/admin/tools/:tool/instances/:name/credential': { tier: 2 },
  'DELETE /v1/admin/roles/:id': { tier: 3 },
  'DELETE /v1/admin/sso/role-rules/:id': { tier: 3 },
  'DELETE /v1/admin/tools/:tool/certificates': { tier: 2 },
  'DELETE /v1/admin/tools/:tool/instances/:name': { tier: 3 },
  'DELETE /v1/admin/tools/:tool/instances/:name/certificates': { tier: 2 },
}

const matchers = Object.entries(confirmationRoutes).map(([key, route]) => {
  const [method, pattern] = key.split(' ') as [string, string]
  return { method, route, path: new RegExp(`^${pattern.replace(/:\w+/g, '[^/]+')}$`) }
})

export function confirmationRouteFor(method: string, path: string): ConfirmationRoute | undefined {
  return matchers.find(matcher => matcher.method === method.toUpperCase() && matcher.path.test(path))?.route
}
