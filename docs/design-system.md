# Design system

The web UI is built in four layers: tokens, then components, then patterns, then pages.
Pages compose components and never style themselves.
This document is the reference for every current and future screen.

## Files

| File | Owns |
| --- | --- |
| `src/server/admin/design/tokens.ts` | Every colour, size, radius, shadow and font, for light and dark. The only place these values appear. |
| `src/server/admin/design/components.ts` | Component classes, using tokens only, plus base element styles for content that has no component yet. |
| `src/server/admin/design/ui.ts` | Render helpers that own component markup, escaping and ARIA, including the app shell and the icon sprite. |

`adminStyle` in `src/server/admin/assets.ts` concatenates tokens and components and is served from `/admin/assets/style.css`.

## Constraints

- Pages are server-rendered HTML through `browserPage`.
- The content security policy allows only same-origin scripts and styles, so there are no web fonts, CDNs, inline scripts or inline styles.
- Reading and navigating work without JavaScript; disclosures use native `<details>`, and the narrow-screen menu uses a `#nav` fragment.
- Every mutation keeps its API, CSRF token, `expectedRevision` and recent-auth flow.

## Rules

`test/design-system.test.ts` enforces these rules over the UI sources and rendered pages:

- No hex, `rgb(` or `hsl(` colour outside `tokens.ts`.
- No `style` attribute in any rendered page.
- Every icon is a `<use>` of a symbol in the shared sprite; pages contain no ad hoc SVG shapes.
- One `h1` per page.

## Tokens

Colours are neutral, and colour is reserved for status, so red, amber and green always mean something.
Both palettes are defined in `tokens.ts`; dark values apply under `prefers-color-scheme: dark`, and there is no theme toggle.
Text pairs meet WCAG 2.2 AA (4.5:1), and control outlines, focus rings and status colours meet 3:1, in both themes.

- Surfaces: `--bg`, `--bg-subtle`, `--bg-muted`, `--bg-hover`, `--bg-active`.
- Lines: `--border` (decorative), `--border-strong` (labelled buttons), `--control` (inputs and checkboxes).
- Text: `--text`, `--text-muted`, `--text-faint`.
- Actions: `--primary`, `--primary-hover`, `--primary-fg`, `--danger-solid`, `--focus`.
- Status: `--ok`, `--warn`, `--err`, `--info`, each with `-soft` and `-border`.
- Elevation, used only by floating layers: `--shadow-pop`, `--overlay`.
- Type: `--font`, `--mono`, and sizes `--fs-xs` 12, `--fs-sm` 13, `--fs-base` 14, `--fs-md` 16, `--fs-lg` 20, `--fs-xl` 24.
- Shape and layout: `--r-sm`, `--r-md`, `--r-lg`, `--r-full`, `--ctl-h`, `--ctl-h-sm`, `--side-w`, `--content-max`, `--content-narrow`, `--aside-w`, `--topbar-h`, `--gutter`.

Spacing uses a 4px grid.
Motion is limited to 120ms colour and background transitions, and none under `prefers-reduced-motion`.
Icons are drawn on a 24px grid with a 1.75 stroke in `currentColor`, shown at 16px.

## Components

| Component | Markup | States | Accessibility |
| --- | --- | --- | --- |
| App shell | `appShell()`: `.app`, `.side`, `.main`, `.topbar`, `.content` | Administrator (sidebar), ordinary or must-change user (top bar only), signed out (auth card) | Skip link to `main#main`; `nav` labelled "Administration" |
| Nav item | `.nav-item`, `.nav-label` | default, hover, current | `aria-current="page"` on the current section |
| Recent-auth pill | `.unlock.on`, `.unlock.off` | unlocked with minutes left, locked | Text carries the state; refreshed every 30 seconds |
| Account menu | `.account-menu` with `.popover` | closed, open | Native disclosure; "Signed in as" is announced |
| Learn panel | `.learn` with `.learn-panel` | closed, open | Native disclosure holding the page help |
| Page header | `pageHeader()`: `.page-head` | title, optional one-line description | The page's only `h1` |
| Button | `.btn` with `.btn-primary`, `.btn-secondary` or `.btn-ghost`; `.btn-sm`, `.btn-icon` | default, hover, focus, disabled | Icon-only buttons need `aria-label` |
| Card | `card()`: `.card`, `.card-head` | plain | `h2` per card |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Avatar | `.avatar` | | Initials are `aria-hidden`; the name is adjacent text |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot` | open | `showModal`, Esc closes, title names the action |
| Auth card | `.auth`, `.auth-card` | | One `h1` |
| Message | `#message.message` | empty (hidden), error | Live region for action results |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
Below 760px the sidebar collapses behind a menu button in the top bar and opens full screen.

## Changing the UI

- Build new UI from existing components.
- Add a genuinely new component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
