export interface AdminBrowser {
  browser: (script: string) => string
  url: () => string
  advanceClock: (minutes: number) => Promise<void>
}
export function useAdminBrowser(name: string): AdminBrowser
