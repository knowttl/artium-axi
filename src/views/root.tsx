import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { Overview, type OverviewProps } from './overview.js'

export interface ViewProps { overview: OverviewProps }
export type ViewName = keyof ViewProps

const views = { overview: Overview }

export function Root<Name extends ViewName>({ name, props }: { name: Name, props: ViewProps[Name] }) {
  const View = views[name] as (props: ViewProps[Name]) => React.JSX.Element
  return <Theme theme={neutralTheme}><View {...props} /></Theme>
}
