# Design system

The legacy web UI is built in four layers: tokens, then components, then patterns, then pages.
Overview uses the Astryx render seam inside the legacy shell.
This document describes the current screens and their design rules.

## Files

| File | Owns |
| --- | --- |
| [tokens.ts](../src/server/admin/design/tokens.ts) | Legacy colour values and shared typography, radius, shadow, control-size and layout tokens, including light and dark palettes. |
| `src/server/admin/design/components.ts` | Component classes and geometry using the shared tokens, plus base element styles for content that has no component yet. |
| `src/server/admin/design/ui.ts` | Render helpers that own component markup, escaping and ARIA, including the app shell and the icon sprite. |
| `src/server/admin/design/status.ts` | The status vocabulary: one word and tone per state, the badge and status-dot helpers, and the product display name and mark of each tool. |

`adminStyle` in `src/server/admin/assets.ts` concatenates tokens and components and is served from `/admin/assets/style.css`.
The build also produces a React and Astryx browser bundle and the Astryx neutral stylesheet, served at `/admin/assets/hydrate.js` and `/admin/assets/astryx.css`.
Pages on the render seam load them; every other page still renders through the layers above.

## Render seam

A page on the seam is a React view in `src/views`, registered in `src/views/root.tsx` with the JSON-serializable props type its route builds.
`renderPage()` in `src/server/admin/render-page.tsx` server-renders the view inside the page frame with `renderToString`, moves every `style` attribute it emits into the response's one nonce'd `<style>` element through `hoistInlineStyles()`, and adds `astryx.css`, the frame and view props as an `application/json` data block and `hydrate.js`.
`src/client/hydrate.tsx` first writes each hoisted declaration back onto its element through `element.style`, which the policy allows because it is not markup, then reads the root's view name and the data block and hydrates the same tree.
React therefore finds the markup it rendered and owns later style changes.
Overview is the first page on the seam.

The page frame is `Frame` in `src/views/frame.tsx`, built on Astryx `AppShell`, `TopNav` and `Breadcrumbs`: a header with the breadcrumb, a content area with the page title, description and an actions slot, and the side navigation slot.
`adminChrome()` in `src/server/admin/design/ui.ts` builds the breadcrumb, brand, administration links, account menu, confirmation pill and help panel once for both the frame and the legacy shell, so the links, landmarks and titles stay identical.
Until the side navigation moves to Astryx, the frame renders the legacy markup for the brand, links, account menu, confirmation pill and help panel through `dangerouslySetInnerHTML`, so React neither re-renders nor compares what `confirm.js` updates there.
Below the Astryx mobile breakpoint `AppShell` replaces the header and side navigation after hydration, so `confirm.js` looks the confirmation pill up each time it updates it instead of keeping the first element.
Astryx `TopNav` and `Breadcrumbs` add two navigation landmarks, "Page header" and "Breadcrumb", beside "Administration".
The toast regions, confirmation dialogs and icon sprite that `confirm.js` drives stay outside the React root.
A view that shows a time wraps it in `<time suppressHydrationWarning>`, because `confirm.js` formats every `time[datetime]` before hydration.
Views avoid Astryx components that emit inline SVG or style values the hoister rejects (`Grid`, `Avatar`, `ProgressBar`, the default `Stepper` and `Banner` icons, and `Table` without its own `scrollWrapper`).
The legacy base rules for headings, paragraphs, links and table elements skip content inside `[data-astryx-root]`.

## Constraints

- Pages are server-rendered HTML through `browserPage`.
- The content security policy allows only same-origin scripts, styles and fonts, plus the response's own nonce for one `<style>` element, so there are no CDNs, inline scripts or `style` attributes.
  Each browser response gets a fresh unpredictable nonce, available to handlers as `reply.styleNonce`.
  The policy never includes `unsafe-inline` or a `style-src-attr` allowance.
- `hoistInlineStyles()` in `src/server/admin/inline-styles.ts` can move supported `style` attributes into a nonce'd element and throws on declarations it cannot prove safe.
  `renderPage()` calls it on every rendered view, and it returns no style element when there are no declarations.
- Figtree (SIL Open Font License) is self-hosted: the build copies four weights from `@fontsource/figtree` to `/admin/assets/fonts/` and adds the `@font-face` rules to `astryx.css`, which the Astryx neutral `Figtree` font-family tokens already name.
- Reading and navigating work without JavaScript; disclosures use native `<details>`, and the narrow-screen menu uses a `#nav` fragment.
- Every mutation keeps its API, CSRF token, `expectedRevision` and recent-auth flow.

## Rules

`test/design-system.test.ts` enforces these rules over the served stylesheet and rendered pages:

- No colour literal of any form outside `tokens.ts`, including named colours, transparent, hex, rgb/rgba, hsl/hsla, hwb, oklch, oklab, lab, lch and color(), in stylesheets or rendered colour presentation attributes.
- `currentColor` and token references inherit colours; `none` means no paint.
- No `style` attribute in any rendered page; at most one `<style>` element is allowed, and it must carry the response's nonce and contain no colour literal.
- Every stylesheet and page resource is same-origin: no `@import`, no remote or `data:` `url()`, no remote `link`, `script` or `img`, and the policy has no `unsafe-` source, `style-src-attr` or remote `font-src`.
- Hand-written client and view source under `src/client` and `src/views` has no colour literal; colours come from the Astryx theme.
- Every icon is a `<use>` of a symbol in the shared sprite; pages contain no ad hoc SVG shapes.
- One `h1` per page.

## Tokens

Colours are neutral, and colour is reserved for status, so red, amber and green always mean something.
The legacy palettes are defined in `tokens.ts`.
The System, Light and Dark switch appears on GET pages, including sign-in and error pages, except under `/auth/sso/`.
It is absent from POST responses, including completion and error pages.
The choice is remembered in the `artium-theme` cookie (`system`, `light` or `dark`; anything else means system).
The server writes explicit Light or Dark choices as `data-theme` on the root element and omits the attribute for System.
Dark values apply under `data-theme="dark"`, or under `prefers-color-scheme: dark` when no explicit choice is set, and light values apply under `data-theme="light"` whatever the system prefers.
Astryx views follow the same attribute through their `light-dark()` tokens.
Text pairs meet WCAG 2.2 AA (4.5:1), and control outlines, focus rings and status colours meet 3:1, in both themes.

- Surfaces: `--bg`, `--bg-subtle`, `--bg-muted`, `--bg-hover`, `--bg-active`.
- Lines: `--border` (decorative), `--border-strong` (labelled buttons), `--control` (inputs and checkboxes).
- Text: `--text`, `--text-muted`, `--text-faint`.
- Actions: `--primary`, `--primary-hover`, `--primary-fg`, `--danger-solid`, `--danger-fg`, `--focus`.
- Status: `--ok`, `--warn`, `--err`, `--info`, each with `-soft` and `-border`.
- Elevation: `--shadow-pop` and `--overlay` for floating layers; `--shadow-sm` for the selected segmented-control option.
- Type: `--font`, `--mono`, and sizes `--fs-xs`, `--fs-sm`, `--fs-base`, `--fs-md`, `--fs-lg`, `--fs-xl`; values are defined in `tokens.ts`.
- Shape and layout: `--r-sm`, `--r-md`, `--r-lg`, `--r-full`, `--ctl-h`, `--ctl-h-sm`, `--side-w`, `--content-max`, `--content-narrow`, `--aside-w`, `--topbar-h`, `--gutter`.

Use a 4px spacing grid for new components.
Colour, background, switch-thumb and disclosure-icon transitions last 120ms, with no transitions under `prefers-reduced-motion`.
Icons are drawn on a 24px grid with a 1.75 stroke in `currentColor`, shown at 16px.

## Legacy components

| Component | Markup | States | Accessibility |
| --- | --- | --- | --- |
| App shell | `appShell()`: `.app`, `.side`, `.main`, `.topbar`, `.content` | Administrator (sidebar), ordinary user (top bar only), signed out or `layout: 'auth'` (auth card) | Skip link to `main#main`; sidebar `nav` labelled "Administration" |
| Nav item | `.nav-item`, `.nav-label` | default, hover, current | `aria-current="page"` on the current section |
| Recent-auth pill | `.unlock.on`, `.unlock.off` | unlocked with minutes left, locked | Text carries the state; refreshed every 30 seconds |
| Account menu | `.account-menu` with `.popover` | closed, open | Native disclosure; "Signed in as" is announced |
| Learn panel | `.learn` with `.learn-panel` | closed, open | Native disclosure holding the page help |
| Breadcrumb | `.crumbs` | section group, or a parent page link on detail pages | Current page in `strong` |
| Summary card | `.card` with `.summary` | neutral, warning | Label, value and one sentence |
| Page header | `pageHeader()`: `.page-head`, `.actions`; identity variant `.page-head.identity`, `.meta` | title, optional one-line description, actions (at most one primary), identity variant with a lead avatar or `toolIcon(tool, 'lg')` and badges | The page's only `h1`; detail pages name their list page in the breadcrumb |
| Button | `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger-outline` or `.btn-danger`; `.btn-sm`, `.btn-icon`; `.btn-ghost.danger` for a quiet destructive row action | default, hover, focus, disabled | Icon-only buttons need `aria-label`; verbs name the result |
| Badge and status | `badge()`, `status()` from `status.ts`: `.badge` with `.ok`, `.warn`, `.err`, `.info`, `.solid`; `.status` with `.dot` | words from the status vocabulary only | The word is always present; the dot is `aria-hidden` |
| Chip | `.chip`, `.chips` | plain, link | Role chips name the grant origin (Direct, SSO rule) where it matters |
| Card | `card()`: `.card`, `.card-head`, `.card-body`, `.card-foot`, `.card-note`; `.card.danger`, `.card.empty` | plain, with header actions, with footer actions, danger zone, empty state | `h2` per card |
| Table | `.tbl` in `.table-wrap`; `.cell-main`, `.row-link`, `.num`, `.actions-cell`, `.stacked`; `.row-links`, `.stack`, `tr.sel`; `pager()` footer | row links, selected row, dimmed row, numeric column, stacked rows below 760px | Real `<table>`; the row link is the first-cell anchor, stretched over the row, not a JavaScript click |
| Field | `field()`: `.field`, `.hint`; `.input`, `.select`, `.input.mono`, `.input.narrow`; `checkOption()`: `.check`; `.options` fieldset | default, focus, invalid, disabled | `label for`; hints linked by `aria-describedby` |
| Callout | `callout()`: `.callout` with `.info`, `.ok`, `.warn`, `.err` | with optional actions and additional detail | `role="status"` by default; blocking errors use `role="alert"` |
| Steps | `.vsteps`, `.vstep` (`.done`, `.current`) | done, current, to do | Ordered list; done steps carry hidden "Done:" text |
| Key-value list | `.kv` | | `<dl>` |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Avatar and tool icon | `avatar()`: `.avatar`, `.avatar.lg`; `toolIcon()`: `.tool-ico`, `.tool-ico.lg`, using a mark from `toolProducts` | sm, lg | Initials and marks are `aria-hidden`; the name is adjacent text |
| Overflow menu | `.more-menu` with `.popover` | closed, open | Native disclosure with `aria-label` on its icon summary |
| Side sheet | `sheet()`, `sheetLink()`: `dialog.sheet` with `.sheet-head`, `.sheet-body`, `.sheet-foot`, `.scrim` | closed, open as a modal, open from `?sheet=<name>` without JavaScript | Modal focus handling from `showModal`; Close and Cancel are links back to the page |
| Option tile | `.tiles`, `.tile`, `.tool-ico` | unchecked, checked | Native checkbox inside its label |
| Inline editor and menu | `.inline-edit`, `.menu` with `.popover` | closed, open | Native disclosure; works without JavaScript |
| Filter row | `.filters`, `.input-wrap`, `.seg`, `.filter`, `.filter.set` | unset (dashed), set (with clear link) | One GET form; selects submit on change, Apply remains without JavaScript |
| Docked sheet | `.split`, `.sheet.docked`, `.sheet-head`, `.sheet-body`, `.kv`, `.code`, `.copyfield` | open beside its list; above it below 760px | `aside` labelled by its `h2`; opened by a `?record=` link, so it works without JavaScript |
| Option card | `.options`, `.option` | unchecked, checked | Native radio |
| Code and copy | `copyBlock()`, `copyField()`, `copyValue()`: `[data-copy-scope]` with `[data-copy]` and `.copy-status`; existing `.copy-group` fields also supported | idle, copied, copy unavailable (text selected) | The copy result is announced in its status |
| Disclosure card | `details.card.disclosure` | closed, open | Native disclosure |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot`, `.ico-circle` | confirmation tier 2 or 3, identity confirmation; rendered open by a query parameter without JavaScript | `showModal`, Esc closes, title names the action |
| View dialog | `viewDialog()`: a server-rendered open `<dialog>` with `data-close-href` | open | The no-JavaScript fallback for a `?add=` or `?rule=` view; scripts make it modal and closing returns to `data-close-href` |
| Auth card | `.auth`, `.auth-card`, `.auth-head`, `.auth-actions`, `.divider`, `.bigcode`, `.auth-foot` | sign in, password, confirmation, CLI approval, result, error | One `h1`; primary action follows cancel or deny within `.auth-actions` |
| Toasts | `.toasts` with `#toast.toast.ok` and `#message.toast.err` | empty (hidden), success, error, conflict with **Reload latest** | `#toast` is a polite `status` region that shows a tier-1 or tier-2 result after the page reloads; `#message` is an `alert` |
| Steps | `steps()`: `ol.steps`, `.step` | done, fail, to do, current | Ordered list; the state is in visually hidden text |
| Segmented control and search | `.seg` (links or visually hidden radios), `.search`, `.filters` | current or checked | GET forms; JavaScript may apply them live |
| Switch | `.switch` on a native checkbox, or `.toggle` button holding a decorative `.switch` | off, on, disabled | `role="switch"`; checkboxes save with their form; the Enabled button submits a confirmed change |
| Operation catalogue | `.ops`, `details.ops-group`, `label.op` | collapsed, open, filtered, Delete and Bulk tags | Native disclosures and checkboxes; see [label and risk ownership](#write-operation-labels-and-risk) |
| Credential editor | `credentialFields()` styled through `[data-credential-editor]` and `[data-credential-field]` | stored secret, required, hidden | Each input sits inside its label; `aria-describedby` links its hint |
| Tabs | `tabs()`: `nav.utabs` | current, with a note or count | Links with `?tab=`, `aria-current="page"`; each tab is its own server-rendered view |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Patterns

**Status vocabulary.**
[`status.ts`](../src/server/admin/design/status.ts) owns the words and tones for each state and write-access summary.
Use its helpers instead of defining page-specific status labels.

**Sheets.**
Create and edit flows that need several fields open in a side sheet.
Every sheet has a query-parameter view (`?sheet=<name>`) that renders it open on the server for navigation without JavaScript.
Submitting its API form requires JavaScript; with JavaScript the sheet opens as a modal and errors show inside it.

**Destructive placement.**
Destructive actions live in a danger zone card at the bottom of detail pages, or in an overflow menu, never next to Save.

## Write operation labels and risk

Write permission pages show each operation's plain label, then its exact code.
Reviewed operations take their labels, resource groups and Delete and Bulk tags from `tools/inventories/write-operations.json`, never inferred from the operation name.
Administrator-added Check Point event actions appear by exact code under Other operations, without inferred risk tags.
`test/write-operations.test.ts` fails when an adapter's pinned catalogue gains or loses an operation the map does not list, so each new operation is reviewed before it ships.

## Confirmations

**Confirmation tiers.**
API forms opened with `apiFormTag()` or `apiForm()` choose their tier:

- Tier 1 has an empty `data-confirm`: the change saves without an action confirmation dialog, and `data-success-message` (default "Change saved.") is shown in the toast after the page reloads.
- Tier 2 sets `data-confirm` to the consequence and `data-confirm-action` to the verb (the button text when absent), which labels its confirm button and, by default, titles the dialog.
  `data-confirm-title` overrides the dialog title.
- Tier 3 also sets `data-confirm-name`: the dialog shows a red status mark and confirm button, which stays disabled until that exact name is typed.

`data-success-url` sends the person to another page after success; `{id}` in it is replaced with the created record's id.
Recent-auth confirmation and CSRF apply to every tier; revision-checked mutations also include `expectedRevision`.
Confirmation does not change the request, CSRF token, revision check or recent-auth flow.

**Interstitials.**
Sign-in, password, identity confirmation, CLI approval, results and error pages use the auth card, including for signed-in people, who also get a sign-out link under the card.
For the optional provider sign-out choice, see [browser administration](admin-guide.md#browser-administration).
Error pages say what happened and what to do, show the code and a copyable request ID, and offer the viewer's home page.

**Dialog views without JavaScript.**
Add and edit forms that open as dialogs have a query-parameter view rendered open by the server, so their fields and close link remain accessible without scripts.
Submitting API forms requires JavaScript.
Form errors appear inside the open dialog so they remain visible and can receive focus.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
At 760px and narrower the sidebar collapses behind a menu button in the top bar and opens full screen.

## Changing the UI

- Build render-seam views from Astryx components, subject to the constraints above.
- For legacy pages, build from existing components; add a genuinely new legacy component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
