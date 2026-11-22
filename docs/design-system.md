# Design system

The admin web UI is server-rendered Astryx React views styled by seven hand-written stylesheets that ship in one CSS bundle with the Astryx stylesheets.
Overview, People, the person detail page, the Roles list, the role detail page, Invitations, the Tools list, the tool page, the instance page, the Sign-in & SSO list, the who-matches page, the provider page, Access tokens, the Audit log, the SSH audit, the SSH hosts page, the SSH credentials page and the Account page use the Astryx render seam and page frame.
The sign-in, password, confirmation, CLI approval, result and error pages use the Astryx auth view.
This document describes the stylesheets, their token policy, the render seam, the design rules and the checks that cover them.

## Files

| File | Owns |
| --- | --- |
| [tokens.css](../src/server/admin/design/tokens.css) | Palette custom properties, including `light-dark()` pairs and the fixed `--danger-fg` and `--transparent` values, plus typography, radius, control-size, layout and gutter tokens. The only hand-written stylesheet that defines colour values. |
| [base.css](../src/server/admin/design/base.css) | Global box sizing, page background, body text, focus rings, link colour outside the Astryx root, `code`, `pre` and `kbd` fonts, `[hidden]`, 120ms colour transitions and their reduced-motion override, `svg.i`, `.sr-only` and `.skip`. The plain `h2`, link, label and control fallbacks in `.content`, `.auth-card` and `dialog` exclude Astryx descendants. The `h3`, `details`, `summary`, `label small` and `pre` rules in `.content` and `dialog` can also match inside the Astryx root. The `.more-menu`, `.menu` and `.inline-edit` disclosure menus, `.popover-note`, the `.btn-ghost.danger` and `.astryx-button.revoke` variants, `.status` modifiers, form margin resets and the `.modal-foot` and `.dialog-actions` rules. |
| [frame.css](../src/server/admin/design/frame.css) | The top bar, breadcrumbs, side navigation footer, mobile navigation drawer, header controls, account menu, Learn panel, recent-authentication pill (`.unlock`), the `.popover` surface with its button overrides shared with page action menus, and the `.logo` brand mark shared with the auth view. |
| [forms.css](../src/server/admin/design/forms.css) | Shared `.btn` controls and `.link`, `.field`, `.input` and `.select`, `.check`, `.option` cards and `.tile` tiles, `.switch`, `.switch-row` and `.toggle`, the `.seg` segmented control, `.filters` and `.filter` chips, `.copyfield`, the CLI setup host picker (`.host-command`), the credential editor (`[data-credential-editor]`) and the operation picker (`.ops`, `.ops-group`, `label.op`). Base form, fieldset, legend, checkbox, radio and file input styles in `.content` and `dialog`, `fieldset[data-hydration-gate]` as `display: contents`, and the `.astryx-text-input` border override shared with sign-in. |
| [tables.css](../src/server/admin/design/tables.css) | `.table-wrap`, the `.link-rows` row links, and the people, roles, tools, instances, invitations, providers, rules, tokens, audit, SSH events and session tables with their stacked narrow layouts. In `.content` and `dialog`, the base table, cell, column header and last-row border rules exclude Astryx descendants. Caption styles and body header cell font weights can also apply inside the Astryx root. |
| [cards.css](../src/server/admin/design/cards.css) | `.note` and `.hint`, the `.muted`, `.faint` and `.mono` utilities, `.card-body`, `.card-foot` and `.card-note`, `.list-row`, `.avatar`, `.tool-ico`, `.dot` and `.status`, page grids, the `.split` layout with docked record sheets, shared `.sheet-head` and `.sheet-body` layout for docked and modal sheets, `.kv` lists, `.code` and `.copyblock`, `.vsteps` and `.steps`, `.disclosure` and `.all-fields`, `.tool-grid`, `.audit-toolbar` and `.execution`. Also the Advanced tool tab's JSON validation note colours inside the Astryx root (`.note[data-valid]`). |
| [dialogs.css](../src/server/admin/design/dialogs.css) | The `.message` form error box, modal side sheets (`dialog.sheet`, `.scrim`, `.sheet-foot`) including header and body padding overrides and a flexing, scrollable body, native `dialog` and its `::backdrop`, the certificate inspection dialog text and name-change button, and the auth view (`.auth`, `.auth-wrap`, `.auth-foot`, `.auth-help`, `.theme-row`, `.ico-circle`). |
| `src/server/admin/chrome.ts` | Builds the typed breadcrumb, brand, navigation, account menu and help panel data for the frame. |
| `src/views/frame.tsx` | Renders the frame, including its account menu and Learn disclosure. |
| `src/views/theme-switch.tsx` | Renders the theme switch shared by the frame and auth views. |
| `src/views/icon.tsx` | Owns the shared inline icon catalog and markup. |
| `src/server/admin/design/status.ts` | The status vocabulary: one word and tone per state, the badge and status-dot helpers, and the product display name and mark of each tool. |

## Stylesheet bundle

Every page links one stylesheet, `/admin/assets/astryx.css`.
The retired `/admin/assets/style.css` route answers 404.
`scripts/build-admin-client.mjs` writes the bundle at build time by concatenating, in this order, `tokens.css`, `base.css`, `frame.css`, `forms.css`, `tables.css`, `cards.css`, `dialogs.css`, the Astryx reset, the Astryx component stylesheet, the Astryx neutral theme and four self-hosted Figtree `@font-face` rules.
The same script builds the React and Astryx browser bundle, and writes both with the font files to `src/server/admin/client/`, which git ignores.
`registerAdminClientAssets()` in `src/server/admin/client-assets.ts` reads those files when it registers and serves them from `/admin/assets/`, so the server needs the built `client/` directory and none of the stylesheets in `design/`.
`scripts/build.mjs` and the Dockerfile copy `src/server/admin/client` into the built output.
All pages load the stylesheet; render-seam pages also load `hydrate.js`.

The Astryx files put every rule in the cascade layers `reset`, `astryx-base` and `astryx-theme`.
The hand-written files declare no layer, so their normal author declarations outrank normal author declarations in the Astryx layers.
For `!important` author declarations, layer precedence reverses and earlier layers outrank later layers, which outrank unlayered declarations.
Among the hand-written files, the later declaration wins when the other cascade criteria, including importance and specificity, are tied.

## Tokens

**Two token sources.**
`tokens.css` holds the project's palette, type scale, radii, control heights and layout widths.
The Astryx stylesheets define the `--color-*`, `--font-weight-*`, `--spacing-*`, `--border-width`, `--focus-outline-width`, `--size-element-*` and `--radius-element` tokens.

**Policy.**
Where an Astryx token resolves to the value a rule used before, the rule uses the Astryx token.
The extraction reviews checked this with computed styles, the frame, forms, tables and dialogs reviews at the default and 20px root font sizes (see the parity archives below).
The credential editor is the exception to matching the old value.
Its native `.input` and `.select` controls under `[data-credential-field]` or `[data-certificate]` inside the Astryx root use Astryx's surface colour, text colour and element radius to match the surrounding Astryx fields.
Their border colour still uses `--field-border` from `tokens.css`.
Elsewhere, keep the existing pixel or palette value where the Astryx value differs or scales with the browser root font size.
That includes these values:

- Surface, text, border and status colours, because the Astryx palettes yield different values in light or dark mode.
- The popover shadow, because Astryx uses different offsets and opacity.
- Font sizes, corner radii, nonzero spacing, layout dimensions, z-index values and breakpoints.

These come from Astryx:

| Stylesheet | Astryx tokens it uses |
| --- | --- |
| `tokens.css`, `base.css` | None. |
| `frame.css` | `--font-weight-bold`, `--font-weight-medium`, `--font-weight-semibold`, `--border-width` and `--spacing-0`. |
| `forms.css` | `--font-weight-normal`, `--font-weight-medium`, `--font-weight-semibold`, `--border-width`, `--spacing-0`, `--focus-outline-width` and `--size-element-sm` (the height of small buttons and filter chips, and the width of small icon buttons). Also `--radius-element`, `--color-background-surface` and `--color-text-primary` for native controls inside the credential editor's Astryx fields. |
| `tables.css` | `--font-weight-normal`, `--font-weight-medium`, `--font-weight-semibold`, `--border-width`, `--spacing-0` and `--focus-outline-width`. |
| `cards.css` | `--font-weight-bold`, `--font-weight-medium`, `--font-weight-semibold`, `--border-width` and `--spacing-0`. |
| `dialogs.css` | `--font-weight-semibold`, `--border-width` and `--spacing-0`. |

**Palette.**
The palette is neutral grays plus the status hues and the focus colour.
Every value is a `light-dark()` pair except `--danger-fg` (white) and `--transparent`.

- Surfaces: `--bg`, `--bg-subtle`, `--bg-muted`, `--bg-hover`, `--bg-active`, `--code-bg`.
- Lines: `--border` (decorative), `--border-strong` (labelled buttons and option cards), `--control` (inputs and checkboxes), `--field-border` (the Astryx TextInput border override and the native controls inside the credential editor's Astryx fields).
- Text: `--text`, `--text-muted`, `--text-faint`.
- Actions: `--primary`, `--primary-hover`, `--primary-fg`, `--danger-solid`, `--danger-fg`, `--focus`.
- Status: `--ok`, `--warn`, `--err`, `--info`, each with `-soft` and `-border`.
- Elevation: `--shadow-pop` and `--overlay` for floating layers; `--shadow-sm` for the selected segmented-control option.

**Type, shape and layout.**
`--font` is the system sans-serif stack and `--mono` the monospace stack.
Sizes are `--fs-xs` (12px), `--fs-sm` (13px), `--fs-base` (14px), `--fs-md` (16px), `--fs-lg` (20px) and `--fs-xl` (24px).
Radii are `--r-sm` (6px), `--r-md` (8px), `--r-lg` (12px) and `--r-full`.
Control heights are `--ctl-h` (34px) and `--ctl-h-sm` (28px).
Layout tokens are `--side-w`, `--content-max`, `--content-narrow`, `--aside-w`, `--topbar-h` and `--gutter`, which is 32px and 16px at 760px viewport width and narrower.

**Themes.**
The System, Light and Dark switch appears on GET pages, including sign-in and error pages, except under `/auth/sso/`.
It is absent from POST responses, including completion and error pages.
The choice is remembered in the `artium-theme` cookie (`system`, `light` or `dark`; anything else means system).
The server writes explicit Light or Dark choices as `data-theme` on the root element and omits the attribute for System.
The Astryx reset maps `data-theme` to `color-scheme` on `html`, which is `light dark` when the attribute is absent.
The `light-dark()` values in `tokens.css` and in the Astryx theme resolve from that `color-scheme`, so System follows the browser's preference.

**Motion and icons.**
Background, colour and border-colour transitions on links, buttons, summaries and `.btn` last 120ms, as do the switch thumb and the operation group icon.
With reduced motion enabled, the `!important` reset in `base.css` disables these transitions, including the operation group icon transition declared later in `forms.css`.
Icons are `svg.i`, shown at 16px with a 1.75 stroke in `currentColor`.

## Layout breakpoints

The hand-written stylesheets switch layouts at these widths:

| Width | Kind | Effect |
| --- | --- | --- |
| 760px and narrower | Viewport | The gutter halves, the top bar padding follows it and the Learn label is hidden. The people, roles, tools, invitations, providers and rules tables become stacked cards. Tiles, operation bodies and the credential editor use one column. List rows wrap, and the tool grid, split layouts and steps stack, with a docked sheet above its list. Side sheets fill the width. |
| 767px and narrower | Viewport | The desktop side navigation is hidden and the header shows the navigation disclosure. |
| 1080px and narrower | Viewport | `.grid2` becomes one column. |
| Narrower than 760px | Container | The SSH events tables and the sessions table become stacked cards. |
| Narrower than 880px | Container | The audit table becomes stacked cards. |
| Narrower than 900px | Container | The instances and tokens tables become stacked cards. |

## Parity archives

Each extraction compared the new stylesheet with the one it replaced.
Five archives under `docs/` keep the evidence: `frame-css-parity.zip`, `forms-css-parity.zip`, `tables-css-parity.zip`, `cards-css-parity.zip` and `dialogs-css-parity.zip`.
Each holds a `README.txt`, a `before/` folder and an `after/` folder with one PNG per capture.
The README records the baseline and candidate revisions, the stylesheet SHA-256 checksums, the capture method and coverage, and the computed style checks.

| Archive | Pairs | Baseline revision |
| --- | --- | --- |
| `frame-css-parity.zip` | 96 | `64bba2600f9f421d22d67cc445e9cc05582d897d` |
| `forms-css-parity.zip` | 100 | `e8ea8b5aa7ad05924025f1e85b0ced0960facc6d` |
| `tables-css-parity.zip` | 106 | `e769a8670036ace6dfa66fb0973a0ad0ac2bff38` |
| `cards-css-parity.zip` | 142 | `d61c6f773abf3b612c8d7ae11548677a2cee8a74` |
| `dialogs-css-parity.zip` | 80 | `cd1e23edd58669fe899482b1139845de6f1ef16f` |

Each baseline is the revision just before the extraction.
The captures are historical records of those revisions.
They were taken when the hand-written styles were served from `/admin/assets/style.css`, a route that no longer exists, so the archives are read, not re-run.
Each README holds its comparison results; the tables README records three Account pairs that differ only in a synthetic port number.

## Open follow-up

[Issue 591](https://github.com/knowttl/artium-axi/issues/591) tracks what the final extraction review left open.
The decision that affects the stylesheets is the `light-dark()` browser floor.
The palette pairs in `tokens.css` require `light-dark()` support in addition to `color-scheme`.
The fixed values `--danger-fg` and `--transparent` work without `light-dark()`.
In a browser without `light-dark()` support, untyped custom properties such as `--bg` retain the function tokens, so a `var()` fallback value is never selected for those properties.
Declarations that consume those tokens, such as `background: var(--bg)` in `base.css`, become invalid at computed-value time.
Affected declarations include the page background and focus outline in `base.css`, the header surface in `frame.css`, input borders in `forms.css`, row focus in `tables.css`, the card surface in `cards.css`, and the scrim, dialog, backdrop and sign-in surface in `dialogs.css`.
The repository states no browser floor.
The issue asks whether to revert to plain colours per theme, with two palette definitions, or to keep `light-dark()` and document the minimum browser versions.
The issue also asks to tighten the bundle tests.
The current link checks cover the presence of `astryx.css` and the absence of `style.css` in sampled responses, with stylesheet counts and bundle order outside that coverage.

## Render seam

A page on the seam is a React view in `src/views`, registered in `src/views/root.tsx` with the JSON-serializable props type its route builds.
`renderPage()` in `src/server/admin/render-page.tsx` renders a view inside the page frame; `renderAuthPage()` renders the auth view without that frame.
Both use `renderToString` and `hoistInlineStyles()` to move emitted `style` attributes into the response's one nonce'd `<style>` element, then provide the view props and optional frame props as an `application/json` data block and load `hydrate.js`.
`src/client/hydrate.tsx` first writes each hoisted declaration back onto its element through `element.style`, which the policy allows because it is not markup, then reads the root's view name, its theme mode from `data-mode`, and the data block to hydrate the same tree.
The React root passes that mode to `Frame` or `Auth` for the shared `ThemeSwitch`, whose serialized props contain only the form's return path.
React therefore finds the markup it rendered and owns later style changes.
Overview is the first page on the seam, People (`src/views/people.tsx`) is the second, the person detail page (`src/views/person.tsx`) is the third, the Roles list (`src/views/roles.tsx`) is the fourth, the role detail page (`src/views/role.tsx`) is the fifth, Invitations (`src/views/invitations.tsx`) is the sixth, the Tools list (`src/views/tools.tsx`) is the seventh, and the tool page (`src/views/tool.tsx`, `src/views/tool-writes.tsx` and `src/views/tool-access.tsx`) is the eighth.
The Tools list offers no action of its own: enabling and disabling a tool is on the tool page.
The tool page frame holds the setup steps, the Enabled switch (a native `button` with `role="switch"` in an `ActionForm`, which keeps the confirmation text and the button label as the dialog action), the tab links (Astryx link buttons marking the current tab with `aria-current="page"`, so tabs work without JavaScript) and one panel per tab.
The Write permissions, Raw API and Advanced tabs are Astryx views.
The operation picker in `src/views/tool-writes.tsx` derives filtered rows and selection counts for both server rendering and the interactive view.
The search and view inputs belong to the `ops-filter` GET form through the `form` attribute, and the operation checkboxes belong to the write permissions form.
The write permissions fieldset keeps the search, view and operation controls disabled until React hydrates, while the native `details` groups can be opened or closed during page load.
The Instances tab (`src/views/tool-instances.tsx`) is an Astryx table with the Test, Edit, Enable or Disable, and Delete actions, and the Edit sheet on the shared `Sheet`; the actions menu stays a native `details` with the `more-menu` class, and the page's `Card` allows overflow so the menu is not clipped.
The table sits in an `instances-list` container: a table from 900 px of container width, with the instance name and description wrapping in their column, and stacked cards below it, so every action stays inside the card.
Its row props carry the displayed instance details and status, action paths, identity and revision, but no credential values or raw metadata.
The Access tab (`src/views/tool-access.tsx`) is a "Roles that grant" panel with an Astryx `List` row and an instance access `Sheet` per role, and for Kubernetes and Shodan one panel per grant policy with a row and an edit `Sheet` per person.
When the policy can be created and an eligible person has no grant, an add `Sheet` offers a native `select` of people without a grant; the sheets keep their `instances-<role>` and `grants-<policy>-<person or add>` names and `?sheet=` open state.
Its props are the people, role scopes and grants an administrator already sees, and no credential values.
The Add instance sheet (`AddInstanceSheet` in `src/views/tool-instances.tsx`) is on the shared `Sheet` and `ActionForm`, with Astryx `TextInput`, `TextArea` and `Banner` for the instance name, description and warning, and `CredentialEditor` (`src/views/credential-editor.tsx`) for the credential fields.
`credentialEditor()` in `src/server/admin/credential-form.ts` builds the editor's props once from the credential profile, for the Add instance sheet and the instance page's Connection card, so the profile alone decides which fields are secret and the view never infers it from a name.
The sign-in provider's Credential tab renders the same `CredentialEditor`, built by `credentialEditor()` from the provider credential profile.
Credentials are write-only in the editor: a field the profile marks secret is a native, uncontrolled `textarea` with `autocomplete="off"` and no value, inside an Astryx `Field`, so a typed secret is never in React state, in the hydration data or in the markup, and the editor empties it when the sheet closes.
Other text fields are Astryx inputs, selects and number fields stay native.
`CredentialEditor` uses `evaluateCredentialSchema()` in `src/views/credential-schema.ts` to identify required and forbidden fields and check whether the saved identity still applies.
The editor marks required fields, hides and disables forbidden fields, and makes the separate private key and fingerprint inputs optional when a combined PEM is present.
It renders the initial field state from the server-provided values and reads the current form values during hydration.
The Certificate verification fieldset (`CertificateVerification` in `src/views/certificate-verification.tsx`) is React inside `CredentialEditor`, built from the `TlsSection` that `tlsSection()` in `src/server/admin/tls-fields.ts` derives once from the tool's TLS settings and the saved metadata.
Its text, upload, select and removal controls are native and uncontrolled inside Astryx `Field`.
Once React hydrates, each PEM picker reads its selected file into the corresponding textarea.
The picker clears its selection after copying the PEM, leaving the textarea available for edits.
The pasted trusted certificate and each file upload are emptied when the sheet closes, like the secrets.
The hostname choice defaults to hostname verification, or to keeping the saved setting when a fingerprint is stored, followed by Yes and No; removal checkboxes start unchecked.
The GitHub connection card (`GithubConnection` in `src/views/github-connection.tsx`) is a `Panel` with the shared `ActionForm`, on the gh-axi Instances tab to add an instance and on a gh-axi instance page to connect or reconnect it; `githubConnection()` in `src/server/admin/instances.ts` builds its props once for both.
Its props are the start route, the tool revision, the saved origin, the instance's identity and revision, the connected login and expiry, and whether the credential expired; they carry no token, device code or verification link.
The `data-connect-github` form passes the successful start response from `ActionForm` to `useGithubDevice` through `showDevice`.
The `data-github-authorization` panel stays hidden until a connection starts, and React renders the user code and verification link from the start response.
The server-rendered markup and hydration data omit both values.
The start form uses action confirmation, and start, poll and cancel can request identity confirmation through `artium-reauth-request` and retry once if the administrator confirms.
`submitForm` holds the page-wide submit lock while `useGithubDevice` runs.
The polling loop caps each wait at the time remaining before the code deadline.
If the deadline passes during a poll, the lock stays held while the panel shows that it is checking the result.
Cancel clears any pending poll timer, wakes the polling loop and discards any outstanding poll result.
The card reports cancellation as confirmed only after a successful, non-redirected response with `status: cancelled`.
See [GitHub setup](tool-credentials.md#github) for connection and recovery steps.
The instance page (`src/views/instance.tsx`, route `/admin/tools/:tool/instances/:name`) is the ninth page on the seam.
Its header holds the Test connection form and the Enabled switch, and below it come the failure banner, the setup steps, the optional GitHub card, the AWX controller address, the Connection card, the Trusted certificates panel with its inspection dialog, the Danger zone and two notes, in one column.
The Connection card is `CredentialEditor` with the instance's `configured` state and saved non-secret values, which `credentialEditor()` takes from the instance metadata and only for fields the profile does not mark secret; a secret field is the same empty native textarea as in the Add instance sheet, and the editor empties it, and the pasted or uploaded certificate, when the page is left (`pagehide`) as well as when a sheet closes.
The Connection card uses the shared `ActionForm` for credential saves.
The Test connection form passes the [`TestOutcomeProvider`](../src/views/test-outcome.tsx) callback to `ActionForm` as `showTest`.
`submitForm` reads the response with `readTestResponse` and sends the result through that callback.
On the instance page, the result note displays the outcome message, and any returned health updates the header badge and check time, the failure banner and the Test step of the setup list.
The certificate panel uses the last TLS decision for offers that depend on test results, preserving that decision for request errors such as invalid CSRF, revision conflicts and rejections that leave cached health intact.
On the tool page, only the result note reads the outcome.
Both pages consume their path's `credential-test:` entry from session storage after hydration.
The Inspect certificate form passes `showInspection` to `ActionForm`, so `submitForm` hands the inspection response to the Trusted certificates panel, which opens [`CertificateInspectionDialog`](../src/views/certificate-inspection.tsx) instead of reloading.
The Astryx dialog renders the inspection in React and mounts the applicable forms after the response arrives.
Both forms report through the `onMessage` prop of `ActionForm` to a shared message area that resets when the dialog closes.
See the [certificate trust runbook](runbook.md#trusting-one-tool-from-the-administration-ui) for the available actions and recovery steps.
The GitHub connection card on this page is the same `GithubConnection` view, above the Connection card.
The Tools list's Show filter is a row of Astryx link buttons that mark the current view with `aria-current="page"`.
Tools, People and Audit use the shared React [`FilterForm`](../src/views/filter-form.tsx) for their GET forms.
Links for preset views remain available during page load.
See [Browser administration](admin-guide.md#browser-administration) for filter availability and submission behavior.
Invitation creation, resend and linking an existing user use the shared React `ActionForm` with `claimLink`.
After a successful submission, `submitForm` closes the sheet and emits the absolute claim URL with the `artium-claim-link` event.
The React [`ClaimLinkDialog`](../src/views/claim-link.tsx) focuses and selects the URL field when it opens.
See [Sign-in settings](admin-guide.md#sign-in-settings) for copying and dismissing the link.
The provider choice stays a native `select` inside an Astryx `Field`, and the lifetime in days is sent as a number.
The Roles list opens its New role sheet from `?sheet=new-role`, and the earlier `?dialog=new-role` link redirects there.
The role detail page opens its Rename role sheet from `?sheet=rename-role`.
Its tool tiles and Raw API switches stay native checkboxes, because Astryx checkboxes emit inline SVG shapes, and its tool grants form sets `trackChanges` on `ActionForm`, so Save tools stays disabled and Discard hidden until a checkbox differs from its saved state.
`renderPage()` takes an optional heading that replaces the page title in the `h1` and the breadcrumb while the document title and help topic keep the section name.
The Sign-in & SSO list (`SignIn` in `src/views/sign-in.tsx`, route `/admin/settings/sign-in`) is the tenth page on the seam and the who-matches page (`SignInMatches` in `src/views/sign-in-matches.tsx`, route `/admin/settings/sign-in/:id/matches/:ruleId`) is the eleventh.
The list shows the sign-in mode, break-glass readiness and pending invitations as three summary cards, then a Providers panel with each provider's kind, issuer, status and a link to its page; it also opens the Add provider sheets from `?add=choose` (a GET chooser), `?add=entra` and `?add=oidc` (the create form on the shared `Sheet` and `ActionForm`, with its tier 2 confirmation).
Only the requested sheet is rendered, so provider forms never share field IDs on the page.
The chooser carries the empty-state launcher's focus destination into either provider form.
The who-matches page is read-only and shows the people whose last recorded sign-in claims match a role rule.
Their props are provider names, kinds, issuers, a `configured` flag, counts and people an administrator already sees, and carry no credential value.
The provider page (`Provider` in `src/views/provider.tsx`, route `/admin/settings/sign-in/:id`) is the twelfth page on the seam, with a Setup, Credential, Role rules and Settings tab.
It shows the provider's identity, its status and the Enable or Disable sign-in control, the shared `Tabs` strip, and either the setup checklist with its readiness banner and copy fields, the credential form, the role rules or the Provider settings form.
For the setup checklist, the server sends state (whether a credential is saved, whether a break-glass administrator is ready, the readiness problems and the redirect URIs) and the view owns the checklist copy.
Enable and Disable sign-in is an `ActionForm` that patches `/activation` with `expectedRevision` and the opposite `enabled` value; a provider that is not ready shows a disabled button and no form, and the server still refuses activation without a usable credential and break-glass administrator.
The Role rules tab (`?tab=rules`, `RoleRules` in `src/views/role-rules.tsx`) lists each rule with its role, the tools that role grants and its match count, which links to the who-matches page.
Its row menu holds Edit rule, a link to `?tab=rules&rule=<id>`, and Remove rule, an `ActionForm` that sends `DELETE` with `expectedRevision` and needs the rule's value typed to confirm.
Add rule opens the `add-rule` sheet in place and uses `?tab=rules&rule=new` for navigation without JavaScript.
Dismiss Edit rule to return focus to the edited row's menu summary.
Modal promotion removes `rule` while keeping `tab=rules`, and the Add and Edit forms use distinct field IDs.
Both sheets send `providerId`, `claim`, `value` and `roleId` to the role-rules API with a tier 2 confirmation: Add uses POST, and Edit uses PATCH with `expectedRevision`.
The Credential tab (`?tab=credential`, `ProviderCredential` in `src/views/provider-credential.tsx`) is an `ActionForm` that patches `/credential` with `expectedRevision` (the saved credential's revision), `expectedProviderRevision` and the shared `CredentialEditor`, under a tier 2 confirmation that names disabling the provider.
It shows non-secret values (the client ID, tenant, authentication method and thumbprint), a Saved or Needs credential badge and when the credential last changed; a secret field is empty, a blank secret keeps the stored one for the same identity, and a changed tenant, client or authentication method needs a new secret.
The Access tokens page (`Tokens` in `src/views/tokens.tsx`, route `/admin/tokens`) is the thirteenth page on the seam, with a Settings, an All tokens and a Revoke all panel.
Settings is an `ActionForm` that patches `/v1/admin/token-settings` under a tier 2 confirmation; its checkbox and two number inputs stay native and uncontrolled, and its `bodyFrom` converts the hours and days to milliseconds before `submitForm` sends them.
All tokens is an Astryx table with a Revoke `ActionForm` on each token that is not revoked (a tier 2 confirmation, `POST /v1/admin/tokens/<id>/revoke`) and Revoke all is one `ActionForm` that posts to `/v1/admin/tokens/revoke-all`; there is no row menu, so nothing can clip.
The table sits in a `tokens-list` container: a table from 900 px of container width, with the Creator column held to a minimum width, and stacked cards below it.
The status word and tone of a token come from the `token` entry of the status vocabulary in `status.ts`, which the Account token list also uses.
The props carry a token's id, label, creator, access, scope, expiry and status, never its value or hash.

The page frame is `Frame` in `src/views/frame.tsx`, built on Astryx `AppShell`: a header with the breadcrumb, a content area with the page title, description and a row of action links (`FrameAction`: a primary or secondary button that is a link, optionally naming the sheet it opens through `sheetTrigger`), and the side navigation slot.
`adminChrome()` in `src/server/admin/chrome.ts` supplies the breadcrumb, brand, administration links, account menu and help panel data that `Frame` renders.
The side navigation is an Astryx `SideNav` with a `SideNavSection` per group and a `SideNavItem` per link, whose current page is derived from the request path.
The frame renders `AccountMenu`, `HelpPanel` and `ThemeSwitch` from typed data.
`pageHelp` in `src/server/admin/forms.ts` supplies plain-text paragraphs for both the frame's Learn panel and the auth view's Need help? disclosure, with fallback text for unknown topics.
Views render without `dangerouslySetInnerHTML`.
The frame receives the remaining confirmation time as typed data and uses one countdown for both copies of the React pill.
The [pill component](../src/views/reauth.tsx) updates the text, `.unlock.on` or `.unlock.off` class, and lock icon together.
The identity confirmation dialog hands the remaining duration to the frame through `artium-reauth` after password confirmation or verified SSO confirmation.
The SSO completion page uses `/admin/assets/reauth-complete.js` to notify `ReauthDialog` in the original window.
The dialog checks the message's origin and popup source, then verifies recent confirmation for the current session with `/reauth?status=1` before resuming the pending action.
See [browser administration](admin-guide.md#browser-administration) for the refresh cadence and confirmation flow.
Below the Astryx mobile breakpoint a native navigation disclosure remains usable without JavaScript, listing the same `SideNavItem` links without a second `SideNav`, and CSS hides the desktop sidebar.
The frame retains one banner, one main and one navigation landmark, labelled "Administration" for administrators and "Account" for other people.
The root contains the toasts and both confirmation dialogs.
`ActionForm` submits plain forms through [`submitForm`](../src/views/submit.ts), which starts the body from the captured `FormData` or the form's `bodyFrom` result.
It includes the CSRF token, applies conversions from the captured `data-type` controls and sends `expectedRevision` for revision-checked mutations.
For a credential form, `submitForm` reads any pending PEM selection captured by the submit and builds the request's `value` from the captured values of the profile and TLS controls.
When the endpoint changes, it omits an untouched connection IP or certificate name.
After creating or updating an instance with credentials, `submitForm` runs the optional connection test and stores the save message with any normalization notices and test outcome.
`ActionForm` uses `artium-confirm` for action confirmation and `artium-reauth-request` for identity confirmation.
After certificate trust is saved, `submitForm` tests with `X-Artium-Retest: 1` and stores the outcome for the reloaded instance page.
Once React handles a submit, `submitForm` holds a page-wide submit lock and captures the submitted values before waiting for `astryx-hydrated`, when the dialog listeners are ready.
Wrap migrated administration form controls, including submit buttons, in the shared [`HydrationGate`](../src/views/hydrated.tsx).
It renders a disabled `fieldset` (`data-hydration-gate`, shown as `display: contents`) until React hydrates.
`ActionForm` and `Sheet` apply the gate for API submissions, and `FilterForm` applies it for list filters.
For a custom form such as the provider-kind chooser, place the gate inside the form around its controls.
`ActionForm` leaves the fieldset enabled for routes with a `native` entry in `src/shared/confirmation-routes.ts`, so those forms can post to the server confirmation page without JavaScript.
See [browser administration](admin-guide.md#browser-administration) for the actions that support server confirmation.
The New role and Rename sheets pass no confirmation text, so they submit without a confirmation dialog.
Astryx checkboxes emit inline SVG shapes, so the role and administrator checkboxes stay native.
`ActionForm` in `src/views/action-form.tsx` owns the `data-api` form attributes (method, consequence, title, action, typed name, success URL and success message) and the submission itself, and `Sheet` builds on it, so a view writes an API form without repeating them.
The person detail page's "More actions" overflow menu keeps a native `details` disclosure, because Astryx dropdown components need runtime inline styles (see issue 462), and builds its items from Astryx `Button` and `ActionForm`.
The Sessions card (`Sessions` in `src/views/sessions.tsx`) is also on the Account page; see the Account rendering details below.
The People filter chips are native `select` elements.
Views render timestamps with `Time` in `src/views/time.tsx`.
See [browser administration](admin-guide.md#browser-administration) for the timestamp display behavior.
The CLI approval page's Go back button (`BackButton` in `src/views/auth.tsx`) renders hidden and appears once hydrated when the browser has history.
Views avoid Astryx components that emit inline SVG or style values the hoister rejects (`Avatar`, `ProgressBar`, the default `Stepper` and `Banner` icons, and `Table` without its own `scrollWrapper`).
The `base.css` fallbacks for `h2`, links, labels, selects, textareas and buttons exclude descendants of `[data-astryx-root]`, as do the default input styles for types other than checkbox, radio, hidden and file, and the disabled field rules.
The `tables.css` fallbacks for tables, cell layout, column headers and last-row borders use the same exclusion.
Plain `h3` styles, captions and body header cell weights can still apply inside the Astryx root in `.content` or `dialog`.
The Audit log (`AuditLog` in `src/views/audit.tsx`, route `/admin/audit`) is the fourteenth page on the seam.
It is a GET filter form (Request ID and Token ID search, the Time range link group, the Failed runs only link, native `select` chips for User, Tool, Instance, Event and Outcome, the Error code chip that appears only when the query sets it, and the From and To fields of a custom range), an Export menu (a native `details` with the CSV and JSON lines download links to `/v1/admin/audit/export` for the applied filters), the records table and a cursor pager.
Its props carry what a row displays (time, event, break-glass flag, actor name, tool, instance and outcome word and tone) and no other stored field; the open record is a separate `detail` prop.
The record detail panel (`AuditDetail` in `src/views/audit-detail.tsx`, opened by `?record=<id>`) is a docked `aside` beside the list with a Close details link, the facts (actor, tool, instance, outcome, a read-only Request ID with a copy button, client address, sign-in method, action and error code), the Settings changes of an admin change, the Failure diagnostic of a run, and a native `details` disclosure listing every stored field.
Its props are exactly what the panel displays: the heading, time, record number, facts, settings changes as text, the diagnostic as text, and each stored field as text (or an ISO time) with `null` for a field that has no value, so no markup string reaches the page or the hydration data.
A record that is gone shows "Record not found" with the same Close link.
The records table is a container (`container-type: inline-size` on `.audit-list`): when the list is 880px wide or more it is a table, and below that, as with the open panel beside it at 1440px and narrower or on a narrow screen, each row becomes a stacked card that wraps its values, so no column is clipped or scrolled.

The SSH audit (`SshAudit` in `src/views/ssh-audit.tsx`, route `/admin/ssh/audit`) is the fifteenth page on the seam.
The header actions link to Hosts, bindings and grants and to the metadata-only export, which keeps the page's query.
Each retained execution is an article with its outcome and Sudo badges, its facts (host, account, start, finish, remote exit, termination, request ID and output sample state), the command, the diagnostic, the retained standard output and error as text blocks with byte counts, and a native `details` disclosure with the rest of the stored record.
Output is untrusted: it is rendered as text only and its markup characters are escaped in the page and in the hydration data.
Connection events and denials, and the bindings and grants tables of the SSH hosts page, use the `ssh-events` container: a table from 760 px of container width with column minimums that keep short values on one line, and stacked cards below it.
Identifiers wrap at their separators and break mid-word only when no other room remains.
The page keeps the SSH help topic Tools, which `renderPage` takes as its last argument.

The SSH hosts page (`SshHosts` in `src/views/ssh-hosts.tsx`, route `/admin/ssh`) is the sixteenth page on the seam.
Each host is a panel with its revision and Enabled and read-only state, a native `details` disclosure "Edit trust and policy" holding the host form, the Account binding and Caller grant forms, and Delete host with its typed-name confirmation; Register host and the Current bindings and grants tables follow.
Every form keeps its URL, method, `confirm` and `expectedRevision` fields, field names, ids, `data-type` values, defaults (a new host starts disabled and read only) and confirmation text; the integration test compares them with a recorded copy of the previous forms.
The port and three numeric host limits are native number inputs; the client converts them to numbers before sending.
The credential and person selects and the sudo checkboxes stay native.

The SSH credentials page (`SshCredentials` in `src/views/ssh-credentials.tsx`, route `/admin/ssh/credentials`) is the seventeenth page on the seam and the last SSH page to move there.
Each stored credential is a panel with its revision, the two exclusive native `details` choices "Use a private key" and "Use a password" with their forms, and Delete credential with its typed-name confirmation; New encrypted credential follows with the same two forms and a Credential ID field.
Every form keeps its URL, method, `confirm` and `expectedRevision` fields, field names, ids, `autocomplete` values, required flags, labels, the password hint and the confirmation text; the integration test compares the form contract with a recorded copy of the previous forms, excluding CSS classes and CSRF controls.
The private key, passphrase and password fields are native uncontrolled controls: they are never given a value and are not in React state or in the hydration data; the credential props carry ids and revisions only, and a `pagehide` listener clears the fields when that event fires.

The Account page (`Account` in `src/views/account.tsx`, route `/account`) is the eighteenth page on the seam and the last page to leave the legacy shell.
It is available to every signed-in person: administrators get the usual sidebar, and other people get the same frame with the brand and account menu only and no administration links (the navigation landmark is labelled Account instead of Administration).
The header carries the person's name, sign-in method and roles, and a Change password action for local accounts.
The cards come in this order: Your tools, Set up the CLI and Saving files from tools (`AccountGuide`), Temporary access tokens (`AccountTokens` in `src/views/account-tokens.tsx`) and Sessions.
Your tools lists each granted tool with Available or Turned off by admin.
Set up the CLI has three steps: the verified download commands for this server, the sign-in commands for a local or SSO account, and a radio group of four agent hosts that shows one setup command at a time with CSS only, each command in a native copy block.
Saving files from tools is a native `details` disclosure shown only when a granted tool saves files, with guidance for exactly those tools and a table of the latest 20 archive transfers.
The guide receives text and `code` fragments rather than markup strings.
The token card keeps the create form that `ActionForm` posts to `/v1/account/tokens`, the React one-time dialog `#created-token` ([`CreatedTokenDialog`](../src/views/created-token.tsx)), and the person's own token list with a Revoke form per token.
The create form's `bodyFrom` builds the scope from the named tool, instance and command checkboxes and turns the duration or the chosen date into `expiresAt`, and `readOnly` and `reusable` are `data-type` booleans.
The token value reaches the browser only in the response to the create request.
`submitForm` emits it with the `artium-created-token` event and the dialog writes it directly into its read-only field, keeping the value out of the markup, hydration data and React state.
The dismissal handler clears the field before reloading the Account page, and the `pagehide` handler clears it on navigation away.
The Sessions table sits in a `session-list` container and turns into stacked cards below 760px of container width, so every column and the Revoke action stay visible beside the sidebar.

## Constraints

- Pages are server-rendered HTML: `renderPage()` and `renderAuthPage()` render the render-seam views, and `browserDocument()` in `src/server/auth/browser.ts` writes the document around them, with the link to `/admin/assets/astryx.css`.
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

Use colour tokens for hand-written styles and rendered colour presentation attributes, following the [token policy](#tokens).
`currentColor` uses the element's text colour, and `none` means no paint.
Link the single CSS bundle described in [Stylesheet bundle](#stylesheet-bundle), keep resources same-origin, and follow the [style and CSP constraints](#constraints).
Render icons through `Icon` in `src/views/icon.tsx`, which uses `svg.i` with inline shapes on a 24px grid.
Use one `h1` per page.

`test/design-system.test.ts` checks the six hand-written stylesheets other than `tokens.css` for colour literals in declarations, including in shorthands, custom properties, nested at-rules and `var()` fallbacks.
The check covers named colours, transparent, hex, rgb/rgba, hsl/hsla, hwb, oklch, oklab, lab, lch and color().
It also checks that `/admin/assets/style.css` returns 404 and scans the served Astryx bundle for `@import` and absolute or protocol-relative resource references, including `data:` URLs.
For its fixed set of route and viewer combinations, it checks the rendered responses for the following:

- Colour presentation attributes (`fill`, `stroke`, `color`, `bgcolor`, `bordercolor`, `text`, `link`, `alink`, `vlink` and any attribute ending in `-color`) contain no colour literals.
- Stylesheet links include `/admin/assets/astryx.css` and exclude `/admin/assets/style.css`.
- Elements have no `style` attributes, and the response has at most one `<style>` element.
  When present, that element carries the response nonce, contains no colour literals, and passes the same resource checks as the served bundle.
- Resource attributes on elements such as `link`, `script` and `img` have no absolute or protocol-relative references, and the CSP requires same-origin scripts, styles and fonts, permits the style nonce and rejects `unsafe-`, `style-src-attr` and `style-src-elem`.
- Each `<svg>` has `class="i"`, `viewBox="0 0 24 24"` and at least one descendant element, with no `<use>` or `<symbol>` descendants.
- The response has exactly one `h1`.

`test/admin-client-assets.test.ts` checks that the served bundle loads only the four Figtree font files and declares the Astryx theme tokens `--color-text-primary`, `--color-background-surface`, `--color-accent` and `--radius-container`.

## Patterns

**Status vocabulary.**
[`status.ts`](../src/server/admin/design/status.ts) owns the words and tones for each state and write-access summary.
Use its helpers instead of defining page-specific status labels.

**Sheets.**
Create and edit flows that need several fields open in a side sheet.
`SheetFrame` in `src/views/sheet.tsx` renders a native `dialog` that can open on the server for a query view, usually `?sheet=<name>`.
Astryx `Drawer` and `Dialog` render closed until hydration, so the server view uses the native dialog.
Close and Cancel link back to the page without JavaScript.
Once React hydrates, `sheetTrigger` opens an already rendered sheet in place when available.
After hydration, `SheetFrame` promotes a server-open sheet to a modal without firing a dismissal event, removes its opening query parameters while preserving unrelated parameters, and hides the server-rendered scrim.
Close, Cancel and Escape dismiss the modal and return focus to the actual in-page launcher or to the associated control for a server-opened sheet.
For a launcher inside a menu, focus returns to the menu summary.
`Sheet` wraps `SheetFrame` with an `ActionForm` and uses `FormMessage` to show and focus plain-form errors inside the open dialog.

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
- Tier 3 also sets `data-confirm-name`: the dialog asks for that name and shows a red confirm button, which stays disabled until that exact name is typed.

`data-success-url` sends the person to another page after success; `{id}` in it is replaced with the created record's id.
Recent-auth confirmation and CSRF apply to every tier; revision-checked mutations also include `expectedRevision`.
Confirmed browser requests carry a server-issued confirmation token; CSRF, revision checks and recent authentication still apply.

**Interstitials.**
Sign-in, password, identity confirmation, CLI approval, results and error pages use the `Auth` view in `src/views/auth.tsx`, with an Astryx `Card` inside `.auth` and `.auth-wrap` and an optional `.auth-foot`.
`renderAuthPage()` builds the view's props from a list of typed blocks (text, form, buttons, details, banner, code, divider) so a route never writes markup.
The view has one `h1`; the primary action follows cancel or deny in a row of buttons.
Signed-in people also get a sign-out form under the card.
For the optional provider sign-out choice, see [browser administration](admin-guide.md#browser-administration).
Error pages say what happened and what to do, show the code and a copyable request ID, and offer the viewer's home page.

**Dialog views without JavaScript.**
See [sheet behavior](#patterns) for server-rendered add and edit views and [browser administration](admin-guide.md#browser-administration) for actions with a server confirmation page.

## Navigation

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Access tokens, Audit log).
The current section is derived from the request path.
In the render-seam page frame the sidebar is an Astryx `SideNav`; at 767px and narrower it is replaced by a navigation disclosure in the header.
The header stays one row there, and the recent-auth pill and the colour theme switch move into that disclosure.

## Changing the UI

- Build render-seam views from Astryx components, subject to the constraints above.
- Put each rule in the stylesheet that owns its component family (see [Files](#files)).
  A new stylesheet joins the bundle by being added to the `designStylesheets` list in `scripts/build-admin-client.mjs`, and to the colour-literal test in `test/design-system.test.ts`.
- Define new palette colours as `light-dark()` tokens in `tokens.css` and reference them with `var()`.
- Use Astryx tokens when they resolve to the values they replace.
  For native `.input` and `.select` controls in the credential editor's Astryx fields, use the Astryx surface colour, text colour and element radius from the [token policy](#tokens).
