import { Theme, type ThemeMode } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { Frame, type FrameProps } from './frame.js'
import { Overview, type OverviewProps } from './overview.js'

export interface ViewProps { overview: OverviewProps }
export type ViewName = keyof ViewProps

const views = { overview: Overview }

export function Root<Name extends ViewName>({ name, props, frame, mode }: { name: Name, props: ViewProps[Name], frame: FrameProps, mode: ThemeMode }) {
  const View = views[name] as (props: ViewProps[Name]) => React.JSX.Element
  return <Theme theme={neutralTheme} mode={mode}><Frame {...frame}><View {...props} /></Frame></Theme>
}
