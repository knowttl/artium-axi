import { Button } from '@astryxdesign/core/Button'
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'

const themeModeSchema = z.enum(['system', 'light', 'dark'])
export type ThemeMode = z.infer<typeof themeModeSchema>

export const themeCookie = 'artium-theme'
const themeCookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 } as const
const sameOriginPath = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/
const labels: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function readThemeMode(request: FastifyRequest): ThemeMode {
  return themeModeSchema.catch('system').parse(request.cookies?.[themeCookie])
}

export function themeSwitch(reply: FastifyReply, mode: ThemeMode, destination?: string): string {
  const next = destination ?? (reply.request.method === 'GET' ? reply.request.url : '/')
  const stay = !destination && reply.request.method !== 'GET'
  return renderToString(
    <Theme theme={neutralTheme} mode={mode}>
      <form method="post" action="/theme" data-theme-stay={stay || undefined}>
        <input type="hidden" name="next" value={next} />
        {stay && <input type="hidden" name="stay" value="1" />}
        <ButtonGroup label="Colour theme" size="sm">
          {themeModeSchema.options.map(option => (
            <Button key={option} type="submit" name="theme" value={option} label={labels[option]} size="sm"
              variant={option === mode ? 'secondary' : 'ghost'} aria-pressed={option === mode} />
          ))}
        </ButtonGroup>
      </form>
    </Theme>,
  )
}

export function registerThemeRoute(app: FastifyInstance): void {
  app.post('/theme', async (request, reply) => {
    const input = z.object({ theme: themeModeSchema, next: z.string().regex(sameOriginPath).catch('/'), stay: z.literal('1').optional() }).safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    reply.setCookie(themeCookie, input.data.theme, themeCookieOptions)
    return input.data.stay ? reply.code(204).send() : reply.redirect(input.data.next, 303)
  })
}
