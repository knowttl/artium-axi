import { ArtiumError } from '../../shared/errors.js'

export function checkAuthSettings(environment: NodeJS.ProcessEnv): void {
  if (environment.ARTIUM_AXI_DEV !== undefined || environment.ARTIUM_AXI_DEV_TOKEN_FILE !== undefined) {
    throw new ArtiumError('DEV_AUTH_INVALID')
  }
}
