import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { createRoot } from 'react-dom/client'

const root = document.querySelector('[data-astryx-root]')
if (root) createRoot(root).render(<Theme theme={neutralTheme}>{null}</Theme>)
