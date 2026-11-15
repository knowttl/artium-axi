import { Theme, type ThemeMode } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { Auth, type AuthProps } from './auth.js'
import { Frame, type FrameProps } from './frame.js'
import { Invitations, type InvitationsProps } from './invitations.js'
import { Overview, type OverviewProps } from './overview.js'
import { People, type PeopleProps } from './people.js'
import { Person, type PersonProps } from './person.js'
import { Role, type RoleProps } from './role.js'
import { Roles, type RolesProps } from './roles.js'

export interface ViewProps { overview: OverviewProps, auth: AuthProps, people: PeopleProps, person: PersonProps, roles: RolesProps, role: RoleProps, invitations: InvitationsProps }
export type ViewName = keyof ViewProps

const views = { overview: Overview, auth: Auth, people: People, person: Person, roles: Roles, role: Role, invitations: Invitations }

export function Root<Name extends ViewName>({ name, props, frame, mode }: { name: Name, props: ViewProps[Name], frame?: FrameProps, mode: ThemeMode }) {
  const View = views[name] as (props: ViewProps[Name]) => React.JSX.Element
  return <Theme theme={neutralTheme} mode={mode}>{frame ? <Frame {...frame}><View {...props} /></Frame> : <View {...props} />}</Theme>
}
