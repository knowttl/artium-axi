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
| `src/server/admin/design/status.ts` | The status vocabulary and product display names: each state's one word and tone, rendered only through `badge()` and `status()`. |

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
| Page header | `pageHeader()`: `.page-head`, `.actions`, `.meta` | title, optional one-line description, header actions (at most one primary), identity variant with a lead icon and meta badges | The page's only `h1` |
| Breadcrumb | `.crumbs` | section group, or a parent page link on detail pages | Current page in `strong` |
| Button | `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger-outline` or `.btn-danger`; `.btn-sm`, `.btn-icon` | default, hover, focus, disabled | Icon-only buttons need `aria-label` |
| Badge and status | `badge()`, `status()` from `status.ts`: `.badge` with `.ok`, `.warn`, `.err`, `.info`, `.solid`; `.status`; `.dot` | the vocabulary only | The word is always present; the dot is decorative |
| Card | `card()`: `.card`, `.card-head`, `.card-body`, `.card-foot`; `.card.warn`, `.card.danger` | plain, with header actions, with footer, warning | `h2` per card |
| Summary card | `.card` with `.summary` | neutral, warning | Label, value and one sentence |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Table | `.tbl`, `.cell-main`, `.num` | rows, empty state in the card body | Real `<table>` with `scope` |
| Field | `field()`: `.field`, `label`, `.hint` | default, focus, disabled | `label for`; the hint is linked with `aria-describedby` |
| Option card | `.options`, `.option` | unchecked, checked | Native radio |
| Tabs | `tabs()`: `.utabs` | current, with note | Links with `?tab=`; `aria-current="page"`; each tab is its own server-rendered view |
| Steps | `step()` in `ol.vsteps` | done, current, to do | Ordered list; done is also stated in text |
| Callout | `callout()`: `.callout` with `.info`, `.ok`, `.warn`, `.err` | with title, with list | `role="status"` for results, `role="alert"` only for blocking errors |
| Code and copy | `copyBlock()`, `copyField()`, `copyValue()` | idle, copied, copy unavailable (text selected) | The copy result is announced in its status |
| Key-value list | `.kv` | | `<dl>` |
| Segmented control | `.seg` with radio inputs | 2-4 options | Radio group; works without JavaScript |
| Overflow menu | `.menu` with `.popover`; `.danger` item | closed, open | Native disclosure with a labelled summary |
| Disclosure card | `details.card.disclosure` | closed, open | Native disclosure |
| Tool icon | `toolIcon()`: `.tool-ico`, `.tool-ico.lg` | | `aria-hidden`; the product name from `toolName()` is adjacent text |
| Avatar | `.avatar` | | Initials are `aria-hidden`; the name is adjacent text |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot`, `.ico-circle` | confirmation tier 2 or 3, identity confirmation | `showModal`, Esc closes, title names the action |
| View dialog | `viewDialog()`: a server-rendered open `<dialog>` with `data-close-href` | open | The no-JavaScript fallback for a `?add=` or `?rule=` view; scripts make it modal and closing returns to `data-close-href` |
| Auth card | `.auth`, `.auth-card`, `.auth-head`, `.auth-actions`, `.divider`, `.bigcode`, `.auth-foot` | sign in, password, confirmation, CLI approval, result, error | One `h1`; primary action last in reading order |
| Toasts | `.toasts` with `#toast.toast.ok` and `#message.toast.err` | empty (hidden), success, error, conflict with **Reload latest** | `#toast` is a polite `status` region; `#message` is an `alert` |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Patterns

**Status vocabulary.**
Every state has one word, rendered only by `status.ts`; colour is never the only signal.

**Confirmation tiers.**
Tier 1 has no dialog; the success toast and the updated "Last changed" line confirm the change.
Tier 2 passes the consequence as the `apiForm` confirmation: the dialog is titled with the action and its confirm button repeats the verb.
Tier 3 also passes `data-confirm-name`: the dialog turns red and its confirm button stays disabled until that exact name is typed.
Confirmation does not change the request, CSRF token, revision check or recent-auth flow.

**Interstitials.**
Sign-in, password, identity confirmation, CLI approval, results and error pages use the auth card, including for signed-in people, who also get a sign-out link under the card.
SSO viewers retain the optional provider sign-out checkbox, unchecked by default.
Error pages say what happened and what to do, show the code and a copyable request ID, and offer the viewer's home page.

**Dialog views without JavaScript.**
Add and edit forms that open as dialogs have a query-parameter view rendered open by the server, so they work without scripts.
Form errors appear inside the open dialog so they remain visible and can receive focus.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
At 760px and narrower the sidebar collapses behind a menu button in the top bar and opens full screen.

## Changing the UI

- Build new UI from existing components.
- Add a genuinely new component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
