export interface AuthProvider {
  signIn(username: string, password: string): Promise<{ userId: string, mustChange: boolean }>
}
