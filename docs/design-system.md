# Design system

The web UI is built in four layers: tokens, then components, then patterns, then pages.
Pages compose components and never style themselves.
This document is the reference for every current and future screen.

## Files

| File | Owns |
| --- | --- |
| [tokens.ts](../src/server/admin/design/tokens.ts) | All colour values and shared typography, radius, shadow, control-size and layout tokens, including light and dark palettes. |
| `src/server/admin/design/components.ts` | Component classes and geometry using the shared tokens, plus base element styles for content that has no component yet. |
| `src/server/admin/design/ui.ts` | Render helpers that own component markup, escaping and ARIA, including the app shell, the icon sprite and the product display names of tools. |
| `src/server/admin/design/status.ts` | The status vocabulary: a closed map from each state to its word, tone and icon, rendered as a badge or an inline status. |

`adminStyle` in `src/server/admin/assets.ts` concatenates tokens and components and is served from `/admin/assets/style.css`.

## Constraints

- Pages are server-rendered HTML through `browserPage`.
- The content security policy allows only same-origin scripts and styles, so there are no web fonts, CDNs, inline scripts or inline styles.
- Reading and navigating work without JavaScript; disclosures use native `<details>`, and the narrow-screen menu uses a `#nav` fragment.
- Every mutation keeps its API, CSRF token, `expectedRevision` and recent-auth flow.

## Rules

`test/design-system.test.ts` enforces these rules over the served stylesheet and rendered pages:

- No colour literal of any form outside `tokens.ts`, including named colours, transparent, hex, rgb/rgba, hsl/hsla, hwb, oklch, oklab, lab, lch and color(), in stylesheets or rendered colour presentation attributes.
- `currentColor` and token references inherit colours; `none` means no paint.
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
- Type: `--font`, `--mono`, and sizes `--fs-xs`, `--fs-sm`, `--fs-base`, `--fs-md`, `--fs-lg`, `--fs-xl`; values are defined in `tokens.ts`.
- Shape and layout: `--r-sm`, `--r-md`, `--r-lg`, `--r-full`, `--ctl-h`, `--ctl-h-sm`, `--side-w`, `--content-max`, `--content-narrow`, `--aside-w`, `--topbar-h`, `--gutter`.

Use a 4px spacing grid for new components.
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
| Identity page header | `Page.header` with `.page-head.identity`, `toolIcon(tool, 'lg')`, `.meta` | icon, title, badges, actions | Still the page's only `h1` |
| Card | `card()`: `.card`, `.card-head`, `.card-body`, `.card-foot`; `noteCard()` for compact side guidance | plain, head actions, footer actions; a `form.card` saves on its own | `h2` per card, `h3` in a note card |
| Badge and status | `badge()` and `status()` from `status.ts`: `.badge`, `.status`, `.dot` | ok, warn, err, info, neutral | The word is always present; the dot or icon is decorative |
| Callout | `callout()`: `.callout` with `.ok`, `.warn`, `.err`, `.info` | with optional actions | `role="status"` for results, `role="alert"` only for blocking errors |
| Tabs | `tabs()`: `nav.utabs` | current, with a note or count | Links with `?tab=`, `aria-current="page"`; each tab is its own server-rendered view |
| Steps | `steps()`: `ol.steps`, `.step` | done, fail, to do, current | Ordered list; the state is in visually hidden text |
| Table | `.tbl`, `.cell-main`, `.num`; add `.stack-sm` for stacked rows on narrow screens | row link in the first cell | Real `<table>` with `th scope`; stacked cells label themselves from `data-label` |
| Segmented control and search | `.seg` (links or visually hidden radios), `.search`, `.filters` | current or checked | GET forms; JavaScript may apply them live |
| Switch | `.switch` on a native checkbox, or `.toggle` button holding a decorative `.switch` | off, on, disabled | `role="switch"`; part of a form, never auto-saves |
| Operation catalogue | `.ops`, `details.ops-group`, `label.op` | collapsed, open, filtered, Delete and Bulk tags | Native disclosures and checkboxes; labels and tags come from `tools/inventories/write-operations.json` |
| Tool icon | `toolIcon()`: `.tool-ico`, `.tool-ico.lg` | sm, lg | Initials are `aria-hidden`; the product name is adjacent text |
| Credential editor | `credentialFields()` styled through `[data-credential-editor]` and `[data-credential-field]` | stored secret, required, hidden | Each input sits inside its label with a one-sentence hint |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Avatar | `.avatar` | | Initials are `aria-hidden`; the name is adjacent text |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot` | open | `showModal`, Esc closes, title names the action |
| Auth card | `.auth`, `.auth-card` | | One `h1` |
| Message | `#message.message` | empty (hidden), error | Live region for action results |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Status vocabulary

Only `status.ts` renders these words.

| Domain | States (word / tone) |
| --- | --- |
| Tool setup and health | Not set up / neutral · Needs credential / warn · Ready to test / neutral · Failing / err · Healthy / ok |
| Writes | Read-only / neutral · Always read-only / neutral with lock · N operations on / warn · Writes on / warn |

## Write operation labels and risk

Write permission pages show each operation's plain label, then its exact code.
Labels, resource groups and the Delete and Bulk tags come only from the reviewed map in `tools/inventories/write-operations.json`, never from the operation name.
`test/write-operations.test.ts` fails when an adapter's pinned catalogue gains or loses an operation the map does not list, so each new operation is reviewed before it ships.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
At 760px and narrower the sidebar collapses behind a menu button in the top bar and opens full screen.

## Changing the UI

- Build new UI from existing components.
- Add a genuinely new component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
