import { LayerProvider } from '@astryxdesign/core/Layer'
import { Theme, type ThemeMode } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { Account, type AccountProps } from './account.js'
import { ConfirmationTokenContext, type ConfirmationTokens } from './action-form.js'
import { Auth, type AuthProps } from './auth.js'
import { AuditLog, type AuditProps } from './audit.js'
import { Confirmation } from './confirmation.js'
import { Frame, type FrameProps } from './frame.js'
import { Instance, type InstanceProps } from './instance.js'
import { Invitations, type InvitationsProps } from './invitations.js'
import { Overview, type OverviewProps } from './overview.js'
import { People, type PeopleProps } from './people.js'
import { Person, type PersonProps } from './person.js'
import { Provider, type ProviderProps } from './provider.js'
import { Role, type RoleProps } from './role.js'
import { Roles, type RolesProps } from './roles.js'
import { SignIn, type SignInProps } from './sign-in.js'
import { SignInMatches, type SignInMatchesProps } from './sign-in-matches.js'
import { SshAudit, type SshAuditProps } from './ssh-audit.js'
import { SshCredentials, type SshCredentialsProps } from './ssh-credentials.js'
import { SshHosts, type SshHostsProps } from './ssh-hosts.js'
import { Tokens, type TokensProps } from './tokens.js'
import { Tool, type ToolProps } from './tool.js'
import { Toasts } from './toasts.js'
import { Tools, type ToolsProps } from './tools.js'

export interface ViewProps { overview: OverviewProps, auth: AuthProps, people: PeopleProps, person: PersonProps, roles: RolesProps, role: RoleProps, invitations: InvitationsProps,
  tools: ToolsProps, tool: ToolProps, instance: InstanceProps, signIn: SignInProps, signInMatches: SignInMatchesProps, provider: ProviderProps, tokens: TokensProps, audit: AuditProps,
  sshAudit: SshAuditProps, sshHosts: SshHostsProps, sshCredentials: SshCredentialsProps, account: AccountProps }
export type ViewName = keyof ViewProps

const views = { overview: Overview, auth: Auth, people: People, person: Person, roles: Roles, role: Role, invitations: Invitations, tools: Tools, tool: Tool, instance: Instance,
  signIn: SignIn, signInMatches: SignInMatches, provider: Provider, tokens: Tokens, audit: AuditLog, sshAudit: SshAudit, sshHosts: SshHosts, sshCredentials: SshCredentials, account: Account }

export function Root<Name extends ViewName>({ name, props, frame, mode, confirmations }: { name: Name, props: ViewProps[Name], frame?: FrameProps, mode: ThemeMode, confirmations: ConfirmationTokens }) {
  const View = views[name] as (props: ViewProps[Name]) => React.JSX.Element
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <LayerProvider>
        <ConfirmationTokenContext value={confirmations}>
          <Toasts>{frame ? <><Frame {...frame}><View {...props} /></Frame><Confirmation /></> : <View {...props} />}</Toasts>
        </ConfirmationTokenContext>
      </LayerProvider>
    </Theme>
  )
}
