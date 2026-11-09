import { z } from 'zod'

export const instanceNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
