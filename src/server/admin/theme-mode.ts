import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import { themeModes } from '../../views/theme-switch.js'

const themeModeSchema = z.enum(themeModes)
export type ThemeMode = z.infer<typeof themeModeSchema>

export const themeCookie = 'artium-theme'
const themeCookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 } as const
const sameOriginPath = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/

export function readThemeMode(request: FastifyRequest): ThemeMode {
  return themeModeSchema.catch('system').parse(request.cookies?.[themeCookie])
}

export function registerThemeRoute(app: FastifyInstance): void {
  app.post('/theme', async (request, reply) => {
    const input = z.object({ theme: themeModeSchema, next: z.string().regex(sameOriginPath).catch('/') }).safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    return reply.setCookie(themeCookie, input.data.theme, themeCookieOptions).redirect(input.data.next, 303)
  })
}
