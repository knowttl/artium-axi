export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off' | 'neutral' | 'solid'
export interface Status { word: string, tone: Tone }

export const badgeVariants = { ok: 'success', warn: 'warning', err: 'error', info: 'info', off: 'neutral', neutral: 'neutral', solid: 'neutral' } as const
