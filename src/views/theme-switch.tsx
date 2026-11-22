import { Button } from '@astryxdesign/core/Button'
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup'

export const themeModes = ['system', 'light', 'dark'] as const
export type ThemeMode = typeof themeModes[number]

const labels: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export interface ThemeSwitchProps {
  next: string
}

export function ThemeSwitch({ mode, next }: ThemeSwitchProps & { mode: ThemeMode }) {
  return (
    <form method="post" action="/theme">
      <input type="hidden" name="next" value={next} />
      <ButtonGroup label="Colour theme" size="sm">
        {themeModes.map(option => (
          <Button key={option} type="submit" name="theme" value={option} label={labels[option]} size="sm"
            variant={option === mode ? 'secondary' : 'ghost'} aria-pressed={option === mode} />
        ))}
      </ButtonGroup>
    </form>
  )
}
