# Design system

The legacy web UI is built in four layers: tokens, then components, then patterns, then pages.
Overview, People, the person detail page, the Roles list, the role detail page, Invitations, the Tools list, the tool page, the instance page, the Sign-in & SSO list, the who-matches page and the provider page use the Astryx render seam and page frame, and the sign-in, password, confirmation, CLI approval, result and error pages use the Astryx auth view; other pages use the legacy shell.
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
All pages load the stylesheet; render-seam pages also load the browser bundle.

## Render seam

A page on the seam is a React view in `src/views`, registered in `src/views/root.tsx` with the JSON-serializable props type its route builds.
`renderPage()` in `src/server/admin/render-page.tsx` renders a view inside the page frame; `renderAuthPage()` renders the auth view without that frame.
Both use `renderToString` and `hoistInlineStyles()` to move emitted `style` attributes into the response's one nonce'd `<style>` element, then provide the view props and optional frame props as an `application/json` data block and load `hydrate.js`.
`src/client/hydrate.tsx` first writes each hoisted declaration back onto its element through `element.style`, which the policy allows because it is not markup, then reads the root's view name and the data block and hydrates the same tree.
React therefore finds the markup it rendered and owns later style changes.
Overview is the first page on the seam, People (`src/views/people.tsx`) is the second, the person detail page (`src/views/person.tsx`) is the third, the Roles list (`src/views/roles.tsx`) is the fourth, the role detail page (`src/views/role.tsx`) is the fifth, Invitations (`src/views/invitations.tsx`) is the sixth, the Tools list (`src/views/tools.tsx`) is the seventh, and the tool page (`src/views/tool.tsx`, `src/views/tool-writes.tsx` and `src/views/tool-access.tsx`) is the eighth.
The Tools list offers no action of its own: enabling and disabling a tool is on the tool page.
The tool page frame holds the setup steps, the Enabled switch (a native `button` with `role="switch"` in an `ActionForm`, which keeps the confirmation text and the button label as the dialog action), the tab links (Astryx link buttons marking the current tab with `aria-current="page"`, so tabs work without JavaScript) and one panel per tab.
The Write permissions, Raw API and Advanced tabs are Astryx views; operation groups stay native `details`, and the filter inputs join the page's `ops-filter` get form through the `form` attribute.
The Instances tab (`src/views/tool-instances.tsx`) is an Astryx table with the Test, Edit, Enable or Disable, and Delete actions, and the Edit sheet on the shared `Sheet`; the actions menu stays a native `details` with the `more-menu` class, and the page's `Card` allows overflow so the menu is not clipped.
Its row props carry the displayed instance details and status, action paths, identity and revision, but no credential values or raw metadata.
The Access tab (`src/views/tool-access.tsx`) is a "Roles that grant" panel with an Astryx `List` row and an instance access `Sheet` per role, and for Kubernetes and Shodan one panel per grant policy with a row and an edit `Sheet` per person.
When the policy can be created and an eligible person has no grant, an add `Sheet` offers a native `select` of people without a grant; the sheets keep their `instances-<role>` and `grants-<policy>-<person or add>` names and `?sheet=` open state.
Its props are the people, role scopes and grants an administrator already sees, and no credential values.
The Add instance sheet (`AddInstanceSheet` in `src/views/tool-instances.tsx`) is on the shared `Sheet` and `ActionForm`, with Astryx `TextInput`, `TextArea` and `Banner` for the instance name, description and warning, and `CredentialEditor` (`src/views/credential-editor.tsx`) for the credential fields.
`credentialEditor()` in `src/server/admin/credential-form.ts` builds the editor's props once from the credential profile, for the Add instance sheet and the instance page's Connection card, so the profile alone decides which fields are secret and the view never infers it from a name.
The sign-in provider's Credential tab renders the same `CredentialEditor`, built by `credentialEditor()` from the provider credential profile.
Credentials are write-only in the editor: a field the profile marks secret is a native, uncontrolled `textarea` with `autocomplete="off"` and no value, inside an Astryx `Field`, so a typed secret is never in React state, in the hydration data or in the markup, and the editor empties it when the sheet closes.
Other text fields are Astryx inputs, selects and number fields stay native, and `confirm.js` still hides alternative-shape fields, sets `required` and builds the submitted value from the `data-profile-field` attributes, so the field names and attributes are the contract between the two.
The Certificate verification fieldset (`CertificateVerification` in `src/views/certificate-verification.tsx`) is React inside `CredentialEditor`, built from the `TlsSection` that `tlsSection()` in `src/server/admin/tls-fields.ts` derives once from the tool's TLS settings and the saved metadata.
Its text, upload and select controls are native and uncontrolled inside Astryx `Field`, so nothing typed or uploaded is in React state, because Astryx `TextInput` is controlled-only; removal uses native checkboxes, and the `data-profile-field`, `data-tls-input`, `data-tls-file`, `data-profile-clearable` and `data-tls-remove` attributes are the contract with `confirm.js`.
The pasted trusted certificate and each file upload are emptied when the sheet closes, like the secrets.
The hostname choice defaults to hostname verification, or to keeping the saved setting when a fingerprint is stored, followed by Yes and No; removal checkboxes start unchecked.
The GitHub connection card (`GithubConnection` in `src/views/github-connection.tsx`) is a `Panel` with the shared `ActionForm`, on the gh-axi Instances tab to add an instance and on a gh-axi instance page to connect or reconnect it; `githubConnection()` in `src/server/admin/instances.ts` builds its props once for both.
Its props are the start route, the tool revision, the saved origin, the instance's identity and revision, the connected login and expiry, and whether the credential expired; they carry no token, device code or verification link.
The form keeps `data-connect-github` and its field names, and posts with the same confirmation and recent-authentication step as before.
The hidden `data-github-authorization` panel keeps the empty `data-github-link`, `data-github-code` and `data-github-status` elements and the `data-cancel-github` button.
After the start route answers, `confirm.js` displays the user code and verification URL, sets the link's `href` to that URL and wires cancellation; neither value is in the server-rendered markup or hydration data.
The elements `confirm.js` fills render with `suppressHydrationWarning`.
The instance page (`src/views/instance.tsx`, route `/admin/tools/:tool/instances/:name`) is the ninth page on the seam.
Its header holds the Test connection form and the Enabled switch, and below it come the failure banner, the setup steps, the optional GitHub card, the AWX controller address, the Connection card, the Trusted certificates panel with its inspection dialog, the Danger zone and two notes, in one column.
The Connection card is `CredentialEditor` with the instance's `configured` state and saved non-secret values, which `credentialEditor()` takes from the instance metadata and only for fields the profile does not mark secret; a secret field is the same empty native textarea as in the Add instance sheet, and the editor empties it, and the pasted or uploaded certificate, when the page is left (`pagehide`) as well as when a sheet closes.
Its form keeps `data-save-tool` and `data-save-instance`, so `confirm.js` sends only the fields that have a value, which leaves an empty secret unchanged on the server.
Astryx text inputs are controlled, so their `defaultValue` follows what is typed; each carries its saved value in `data-saved`, which `confirm.js` compares with the typed URL to decide whether an unedited connection IP or certificate name is dropped with it.
The test, inspection and trust controls keep the `data-test-tool`, `data-check-*`, `data-inspect-certificate`, `data-trust-certificate` and `#certificate-inspection` hooks that `confirm.js` fills in place; the two state badges it swaps in sit in a hidden `data-outcome` element, and it applies a test result saved before a reload only after the page announces `astryx-hydrated`, so React never hydrates markup the script already changed.
The GitHub connection card on this page is the same `GithubConnection` view, above the Connection card.
Elements that `confirm.js` fills before hydration, such as the test result and the JSON check status, render with `suppressHydrationWarning` and matching text so hydration does not discard the page's event handlers.
The Tools list's Show filter is a row of Astryx link buttons that mark the current view with `aria-current="page"`, and its search is the same get form that `confirm.js` submits without empty values.
Invitations keeps the one-time link dialog (`#invitation-link`) as a native `dialog` that `confirm.js` opens after a create or resend form marked with `claimLink` in `ActionForm`, and its provider choice stays a native `select` inside an Astryx `Field`; the lifetime in days is a text input that `confirm.js` sends as a number.
The Roles list opens its New role sheet from `?sheet=new-role`, and the earlier `?dialog=new-role` link redirects there.
The role detail page opens its Rename role sheet from `?sheet=rename-role`.
Its tool tiles and Raw API switches stay native checkboxes, because Astryx checkboxes emit inline SVG shapes, and its tool grants form carries `data-track-changes` through `ActionForm`, so `confirm.js` keeps Save tools disabled until the selection changes.
`renderPage()` takes an optional heading that replaces the page title in the `h1` and the breadcrumb while the document title and help topic keep the section name.
The Sign-in & SSO list (`SignIn` in `src/views/sign-in.tsx`, route `/admin/settings/sign-in`) is the tenth page on the seam and the who-matches page (`SignInMatches` in `src/views/sign-in-matches.tsx`, route `/admin/settings/sign-in/:id/matches/:ruleId`) is the eleventh.
The list shows the sign-in mode, break-glass readiness and pending invitations as three summary cards, then a Providers panel with each provider's kind, issuer, status and a link to its page; it also opens the Add provider sheets from `?add=choose` (a GET chooser), `?add=entra` and `?add=oidc` (the create form on the shared `Sheet` and `ActionForm`, with its tier 2 confirmation).
Only the requested sheet is rendered, open, so its fields do not duplicate those of another provider form, and closing a sheet returns to the list.
The who-matches page is read-only and shows the people whose last recorded sign-in claims match a role rule.
Their props are provider names, kinds, issuers, a `configured` flag, counts and people an administrator already sees, and carry no credential value.
The provider page (`Provider` in `src/views/provider.tsx`, route `/admin/settings/sign-in/:id`) is the twelfth page on the seam, with a Setup, Credential, Role rules and Settings tab.
It shows the provider's identity, its status and the Enable or Disable sign-in control, the shared `Tabs` strip, and either the setup checklist with its readiness banner and copy fields, the credential form, the role rules or the Provider settings form.
The server sends state only (whether a credential is saved, whether a break-glass administrator is ready, the readiness problems and the redirect URIs) and the view owns the checklist copy, so its props carry no credential value.
Enable and Disable sign-in is an `ActionForm` that patches `/activation` with `expectedRevision` and the opposite `enabled` value; a provider that is not ready shows a disabled button and no form, and the server still refuses activation without a usable credential and break-glass administrator.
The Role rules tab (`?tab=rules`, `RoleRules` in `src/views/role-rules.tsx`) lists each rule with its role, the tools that role grants and its match count, which links to the who-matches page.
Its row menu holds Edit rule, a link to `?tab=rules&rule=<id>`, and Remove rule, an `ActionForm` that sends `DELETE` with `expectedRevision` and needs the rule's value typed to confirm.
Add rule opens the closed `add-rule` sheet in place, or `?tab=rules&rule=new` without JavaScript, and Edit rule renders only its own open sheet, so the two forms never share field ids.
Both sheets send `providerId`, `claim`, `value` and `roleId` to the role-rules API with a tier 2 confirmation: Add uses POST, and Edit uses PATCH with `expectedRevision`.
The Credential tab (`?tab=credential`, `ProviderCredential` in `src/views/provider-credential.tsx`) is an `ActionForm` that patches `/credential` with `expectedRevision` (the saved credential's revision), `expectedProviderRevision` and the shared `CredentialEditor`, under a tier 2 confirmation that names disabling the provider.
It shows only the saved non-secret values (the client ID, tenant and thumbprint), a Saved or Needs credential badge and when the credential last changed; a secret field is empty, a blank secret keeps the stored one for the same identity, and a changed tenant, client or authentication method needs a new secret.

The page frame is `Frame` in `src/views/frame.tsx`, built on Astryx `AppShell`: a header with the breadcrumb, a content area with the page title, description and a row of action links (`FrameAction`: a primary or secondary button that is a link, optionally naming the sheet that `confirm.js` opens), and the side navigation slot.
`adminChrome()` in `src/server/admin/design/ui.ts` builds the breadcrumb, brand, administration links, account menu, confirmation pill and help panel once for both the frame and the legacy shell, so the links, landmarks and titles stay identical.
The side navigation is an Astryx `SideNav` with a `SideNavSection` per group and a `SideNavItem` per link, whose current page is derived from the request path.
The frame renders the legacy markup for the account menu, confirmation pill and help panel through `dangerouslySetInnerHTML`, so React neither re-renders nor compares what `confirm.js` updates there.
Below the Astryx mobile breakpoint a native navigation disclosure remains usable without JavaScript, listing the same `SideNavItem` links without a second `SideNav`, and CSS hides the desktop sidebar.
The frame retains one banner, one main and one navigation landmark labelled "Administration".
The toast regions, confirmation dialogs and icon sprite that `confirm.js` drives stay outside the React root.
The People add-user sheet is the first sheet on the seam, the Roles New role sheet is the second, the role Rename sheet is the third, and the Invitations New invitation and Resend sheets are the fourth and fifth; the New role and Rename sheets pass no confirmation text so `confirm.js` submits without a confirmation dialog: `Sheet` in `src/views/sheet.tsx` keeps the native `dialog.sheet`, its `?sheet=` open state and the `data-api` form that `confirm.js` submits, and builds the header, text fields and buttons from Astryx `Heading`, `Text`, `IconButton`, `TextInput` and `Button`.
Astryx `Drawer` and `Dialog` render closed until hydration, so they cannot serve the no-JavaScript view.
Astryx checkboxes emit inline SVG shapes, so the role and administrator checkboxes stay native.
`confirm.js` hides the server-rendered scrim of an open sheet with the `hidden` attribute rather than removing it, so hydration still finds it.
`ActionForm` in `src/views/action-form.tsx` owns the `data-api` form attributes that `confirm.js` reads (method, consequence, title, action, typed name, success URL and success message), and `Sheet` builds on it, so a view writes an API form without repeating them.
The person detail page's "More actions" overflow menu keeps a native `details` disclosure, because Astryx dropdown components need runtime inline styles (see issue 462), and builds its items from Astryx `Button` and `ActionForm`.
The Sessions card (`Sessions` in `src/views/sessions.tsx`) is also on the account page, which is still a legacy page: `renderSessionsCard()` in `src/server/admin/session-card.tsx` renders it there as server-rendered markup in a `data-astryx-root` element, with its inline styles hoisted into a nonce'd `<style>` element, and without hydration.
The People filter chips stay native `select` elements, so filtering works without JavaScript and the form fields are unchanged.
A view that shows a time wraps it in `<time suppressHydrationWarning>`, because `confirm.js` formats every `time[datetime]` before hydration.
Views avoid Astryx components that emit inline SVG or style values the hoister rejects (`Avatar`, `ProgressBar`, the default `Stepper` and `Banner` icons, and `Table` without its own `scrollWrapper`).
The legacy base rules for headings, paragraphs, links, table elements, labels, selects, textareas, buttons and inputs other than checkboxes, radio buttons, hidden and file inputs skip content inside `[data-astryx-root]`, except inside a `legacy-island` element, which keeps them.
Tool views no longer accept `legacyHtml`; the one `legacy-island` element left is the empty certificate details container in the instance page's inspection dialog, which `confirm.js` fills with the inspected chain.

## Constraints

- Pages are server-rendered HTML through `browserPage` or, for render-seam views, `renderPage()` or `renderAuthPage()`.
- The content security policy allows only same-origin scripts, styles and fonts, plus the response's own nonce for one `<style>` element, so there are no CDNs, inline scripts or `style` attributes.
  Each browser response gets a fresh unpredictable nonce, available to handlers as `reply.styleNonce`.
  The policy never includes `unsafe-inline` or a `style-src-attr` allowance.
- `hoistInlineStyles()` in `src/server/admin/inline-styles.ts` can move supported `style` attributes into a nonce'd element and throws on declarations it cannot prove safe.
  Both render-seam entry points call it on every rendered view, and it returns no style element when there are no declarations.
- The one function-bearing value it accepts beyond the layout functions is `repeat(auto-fit, minmax(220px, 1fr))` on `--x-gridTemplateColumns`, the template emitted by the Overview's Astryx `Grid`.
- Figtree (SIL Open Font License) is self-hosted: the build copies four weights from `@fontsource/figtree` to `/admin/assets/fonts/` and adds the `@font-face` rules to `astryx.css`, which the Astryx neutral `Figtree` font-family tokens already name.
- Reading and navigating work without JavaScript; disclosures use native `<details>`.
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
| App shell | `appShell()`: `.app`, `.side`, `.main`, `.topbar`, `.content` | Administrator (sidebar), ordinary user (top bar only) | Skip link to `main#main`; sidebar `nav` labelled "Administration" |
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
| Side sheet | `sheet()`, `sheetLink()`: `dialog.sheet` with `.sheet-head`, `.sheet-body`, `.sheet-foot`, `.scrim` | closed, open as a modal, open from a query parameter without JavaScript | Modal focus handling from `showModal`; Close and Cancel are links back to the page |
| Option tile | `.tiles`, `.tile`, `.tool-ico` | unchecked, checked | Native checkbox inside its label |
| Inline editor and menu | `.inline-edit`, `.menu` with `.popover` | closed, open | Native disclosure; works without JavaScript |
| Filter row | `.filters`, `.input-wrap`, `.seg`, `.filter`, `.filter.set` | unset (dashed), set (with clear link) | One GET form; selects submit on change, Apply remains without JavaScript |
| Docked sheet | `.split`, `.sheet.docked`, `.sheet-head`, `.sheet-body`, `.kv`, `.code`, `.copyfield` | open beside its list; above it below 760px | `aside` labelled by its `h2`; opened by a `?record=` link, so it works without JavaScript |
| Option card | `.options`, `.option` | unchecked, checked | Native radio |
| Code and copy | `copyBlock()`, `copyField()`, `copyValue()`: `[data-copy-scope]` with `[data-copy]` and `.copy-status`; existing `.copy-group` fields also supported | idle, copied, copy unavailable (text selected) | The copy result is announced in its status |
| Disclosure card | `details.card.disclosure` | closed, open | Native disclosure |
| Dialog | native `<dialog class="modal">` with `.modal-body`, `.modal-foot`, `.ico-circle` | confirmation tier 2 or 3, identity confirmation; rendered open by a query parameter without JavaScript | `showModal`, Esc closes, title names the action |
| Toasts | `.toasts` with `#toast.toast.ok` and `#message.toast.err` | empty (hidden), success, error, conflict with **Reload latest** | `#toast` is a polite `status` region that shows a tier-1 or tier-2 result after the page reloads; `#message` is an `alert` |
| Steps | `steps()`: `ol.steps`, `.step` | done, fail, to do, current | Ordered list; the state is in visually hidden text |
| Segmented control and search | `.seg` (links or visually hidden radios), `.search`, `.filters` | current or checked | GET forms; JavaScript may apply them live |
| Switch | `.switch` on a native checkbox, or `.toggle` button holding a decorative `.switch` | off, on, disabled | `role="switch"`; checkboxes save with their form; the Enabled button submits a confirmed change |
| Operation catalogue | `.ops`, `details.ops-group`, `label.op` | collapsed, open, filtered, Delete and Bulk tags | Native disclosures and checkboxes; see [label and risk ownership](#write-operation-labels-and-risk) |
| Credential editor | `CredentialEditor` styled through `[data-credential-editor]` and `[data-credential-field]` | stored secret, required, hidden | Controls have associated labels; `aria-describedby` links their hints |

Elements that no component covers yet (sections, tables, forms, fieldsets and plain buttons inside page content) get neutral base styles from `components.ts`, so existing pages stay readable until they are rebuilt from components.

## Patterns

**Status vocabulary.**
[`status.ts`](../src/server/admin/design/status.ts) owns the words and tones for each state and write-access summary.
Use its helpers instead of defining page-specific status labels.

**Sheets.**
Create and edit flows that need several fields open in a side sheet.
Every sheet has a query-parameter view that renders it open on the server for navigation without JavaScript, normally `?sheet=<name>`; the Add provider sheets use `?add=` as described above.
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
API forms choose their tier:

- Tier 1 has an empty or absent `data-confirm`: the change saves without an action confirmation dialog, and `data-success-message` (default "Change saved.") is shown in the toast after the page reloads.
- Tier 2 sets `data-confirm` to the consequence and `data-confirm-action` to the verb (the button text when absent), which labels its confirm button and, by default, titles the dialog.
  `data-confirm-title` overrides the dialog title.
- Tier 3 also sets `data-confirm-name`: the dialog shows a red status mark and confirm button, which stays disabled until that exact name is typed.

`data-success-url` sends the person to another page after success; `{id}` in it is replaced with the created record's id.
Recent-auth confirmation and CSRF apply to every tier; revision-checked mutations also include `expectedRevision`.
Confirmation does not change the request, CSRF token, revision check or recent-auth flow.

**Interstitials.**
Sign-in, password, identity confirmation, CLI approval, results and error pages use the `Auth` view in `src/views/auth.tsx`, with an Astryx `Card` inside `.auth` and `.auth-wrap` and an optional `.auth-foot`.
`renderAuthPage()` builds the view's props from a list of typed blocks (text, form, buttons, details, banner, code, divider) so a route never writes markup.
The view has one `h1`; the primary action follows cancel or deny in a row of buttons.
Signed-in people also get a sign-out link under the card.
For the optional provider sign-out choice, see [browser administration](admin-guide.md#browser-administration).
Error pages say what happened and what to do, show the code and a copyable request ID, and offer the viewer's home page.

**Dialog views without JavaScript.**
Add and edit forms that open as dialogs have a query-parameter view rendered open by the server, so their fields and close link remain accessible without scripts.
Submitting API forms requires JavaScript.
Form errors appear inside the open dialog so they remain visible and can receive focus.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
On legacy pages, at 760px and narrower the sidebar opens full screen through a `#nav` fragment link in the top bar.
In the render-seam page frame the sidebar is an Astryx `SideNav`; at 767px and narrower it is replaced by a navigation disclosure in the header.
The header stays one row there, and the recent-auth pill and the colour theme switch move into that disclosure.

## Changing the UI

- Build render-seam views from Astryx components, subject to the constraints above.
- For legacy pages, build from existing components; add a genuinely new legacy component to `ui.ts` and `components.ts` first, with all its states, document it here, and review it in light and dark.
- Express new colours or sizes as new tokens, never literals.
