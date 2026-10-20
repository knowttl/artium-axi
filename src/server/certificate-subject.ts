import type { X509Certificate } from 'node:crypto'

export function certificateSubject(certificate: X509Certificate): string {
  if (certificate.subject?.trim()) return certificate.subject
  // Node quotes SAN values containing commas; keep a quoted name intact.
  return certificate.subjectAltName?.match(/^(?:[^",]|"(?:[^"\\]|\\.)*")+/)?.[0].trim() || '(no subject)'
}
