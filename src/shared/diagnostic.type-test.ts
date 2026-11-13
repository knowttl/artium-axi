import type { z } from 'zod'
import type { diagnosticSchema } from './api.js'
import type { Diagnostic } from './errors.js'
import type { StructuredDiagnostic } from './diagnostic.js'

type Reject<T extends false> = T
type Text = 'message' | 'hint' | 'host' | 'issuer' | 'providerCode' | 'transportCode' | 'toolCode'
type HasFreeText<T> = { [K in keyof T]-?: K extends Text ? string extends T[K] ? true : false : false }[keyof T]

export type CacheRejectsRawDiagnostics = Reject<Diagnostic extends StructuredDiagnostic ? true : false>
export type CacheRejectsFreeText = Reject<HasFreeText<StructuredDiagnostic>>
export type ResponseRejectsRawDiagnostics = Reject<Diagnostic extends z.infer<typeof diagnosticSchema> ? true : false>
export type ResponseRejectsFreeText = Reject<HasFreeText<z.infer<typeof diagnosticSchema>>>
