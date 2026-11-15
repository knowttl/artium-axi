export function LegacyIsland({ legacyHtml }: { legacyHtml: string }) {
  return <div className="legacy-island" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: legacyHtml }} />
}
