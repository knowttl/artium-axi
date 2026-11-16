export interface AdminBrowser {
  browser: (script: string) => string
  url: () => string
}
export function useAdminBrowser(name: string): AdminBrowser
