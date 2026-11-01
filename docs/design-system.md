# Design system

The web UI is built in four layers: tokens, then components, then patterns, then pages.
Pages compose components and never style themselves.
This document is the reference for every current and future screen.

## Files

| File | Owns |
| --- | --- |
| [tokens.ts](../src/server/admin/design/tokens.ts) | All colour values and shared typography, radius, shadow, control-size and layout tokens, including light and dark palettes. |
| `src/server/admin/design/components.ts` | Component classes and geometry using the shared tokens, plus base element styles for content that has no component yet. |
| `src/server/admin/design/ui.ts` | Render helpers that own component markup, escaping and ARIA, including the app shell and the icon sprite. |
| `src/server/admin/design/status.ts` | The status vocabulary: one word and tone per state, the badge and status-dot helpers, and product display names for tools. |

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
- Actions: `--primary`, `--primary-hover`, `--primary-fg`, `--danger-solid`, `--danger-fg`, `--focus`.
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
| Page header | `pageHeader()`: `.page-head` | title, optional one-line description, actions (at most one primary), identity variant with a lead avatar or tool icon and badges | The page's only `h1`; detail pages name their list page in the breadcrumb |
| Button | `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger-outline` or `.btn-danger`; `.btn-sm`, `.btn-icon`; `.btn-ghost.danger` for a quiet destructive row action | default, hover, focus, disabled | Icon-only buttons need `aria-label`; verbs name the result |
| Badge and status | `badge()`, `status()` from `status.ts`: `.badge` with `.ok`, `.warn`, `.err`, `.info`, `.solid`; `.status` with `.dot` | words from the status vocabulary only | The word is always present; the dot is `aria-hidden` |
| Chip | `.chip`, `.chips` | plain, link | Role chips name the grant origin (Direct, SSO rule) where it matters |
| Card | `card()`: `.card`, `.card-head`, `.card-body`, `.card-foot`, `.card.danger` | plain, with header actions, with footer actions, danger zone | `h2` per card |
| Stats | `.stats`, `.stat` | value, label, note with tone | Summary cards carry a visually hidden `h2` |
| Table | `.tbl` in `.table-wrap`; `.cell-main`, `.row-link`, `.num`, `.actions-cell`; `.stacked` | row links, dimmed row, numeric column, empty state | Real `<table>`; the row link is the first-cell anchor, stretched over the row, not a JavaScript click |
| Filters | `.filters` GET form with `.input-wrap` search and `.filter` chips | unset (dashed), set | Native selects; with JavaScript they apply on change and the Apply button hides |
| Field | `field()`: `.field`, `.hint`; `.input`, `.select`, `.input.mono`, `.input.narrow`; `checkOption()`: `.check`; `.options` fieldset | default, focus, invalid, disabled | `label for`; hints linked by `aria-describedby` |
| Callout | `callout()`: `.callout` with `.info`, `.ok`, `.warn`, `.err` | with optional actions | `role="status"` |
| Steps and meter | `.vsteps`, `.vstep` (`.done`, `.current`); native `<progress class="meter">` | done, current, to do | Ordered list; done steps carry hidden "Done:" text |
| Key-value list | `.kv` | | `<dl>` |
| Copy field | `.copy-group` with `.copyfield`, `[data-copy]` and `.copy-status` | copied, unavailable | Result announced in the status line |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Avatar and tool icon | `avatar()`: `.avatar`, `.avatar.lg`; `toolIcon()`: `.tool-ico` | sm, lg | Initials are `aria-hidden`; the name is adjacent text |
| Overflow menu | `.more-menu` with `.popover` | closed, open | Native disclosure with `aria-label` on its icon summary |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot` | open | `showModal`, Esc closes, title names the action |
| Side sheet | `sheet()`, `sheetLink()`: `dialog.sheet` with `.sheet-head`, `.sheet-body`, `.sheet-foot`, `.scrim` | closed, open as a modal, open from `?sheet=<name>` without JavaScript | Modal focus handling from `showModal`; Close and Cancel are links back to the page |
| Auth card | `.auth`, `.auth-card` | | One `h1` |
| Message | `#message.message` | empty (hidden), error | Live region for action results |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Patterns

**Status vocabulary.**
`status.ts` owns one word and tone per state: tool health (Healthy, Failing, Not checked), setup (Needs credential), person (Enabled, Disabled, Archived, Locked), invitation (Pending, Expired, Claimed, Revoked), grant origin (Direct, SSO rule), sign-in (Password, SSO, Break-glass, Admin) and tool access (Yes, No, tool disabled, No, person disabled).
Writes read Read-only, Always read-only, or how many operations are on.

**Confirmations.**
`actionForm()` takes the consequence text, a title naming the action and a confirm button verb.
Tier 2 shows them in the shared confirmation dialog.
Tier 3 also names the target, and the red confirm button stays disabled until that exact name is typed; archiving a person uses it.
Forms without a title keep the generic "Confirm change" dialog.

**Sheets.**
Create and edit flows that need several fields open in a side sheet.
Every sheet has a query-parameter view (`?sheet=<name>`) that renders it open on the server, so the flow works without JavaScript; with JavaScript the sheet opens as a modal and errors show inside it.

**Destructive placement.**
Destructive actions live in a danger zone card at the bottom of detail pages, or in an overflow menu, never next to Save.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
At 760px and narrower the sidebar collapses behind a menu button in the top bar and opens full screen.

## Changing the UI

- Build new UI from existing components.
- Add a genuinely new component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
