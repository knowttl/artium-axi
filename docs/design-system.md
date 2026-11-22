# Design system

The legacy web UI is built in four layers: tokens, then components, then patterns, then pages.
Overview, People, the person detail page, the Roles list, the role detail page, Invitations, the Tools list, the tool page, the instance page, the Sign-in & SSO list, the who-matches page, the provider page, Access tokens, the Audit log, the SSH audit, the SSH hosts page, the SSH credentials page and the Account page use the Astryx render seam and page frame, and the sign-in, password, confirmation, CLI approval, result and error pages use the Astryx auth view; no page uses the legacy shell any more.
This document describes the current screens and their design rules.

## Files

| File | Owns |
| --- | --- |
| [tokens.ts](../src/server/admin/design/tokens.ts) | Legacy colour values and shared typography, radius, shadow, control-size and layout tokens, including light and dark palettes. |
| [components.ts](../src/server/admin/design/components.ts) | Global base styles, overflow and inline menus, fallback controls and base elements outside the Astryx root, the `.btn-ghost.danger` and `.astryx-button.revoke` variants, and residual legacy selectors, including the unused `.modal-foot` and `.dialog-actions` rules. |
| [frame.css](../src/server/admin/design/frame.css) | Hand-written styles for the top bar, breadcrumbs, side navigation footer, mobile navigation drawer, account menu, Learn panel and recent-authentication pill. Also owns the brand mark shared with sign-in and the popover styles, including button overrides shared with page action menus. Uses Astryx font weights, border width and zero spacing. |
| [forms.css](../src/server/admin/design/forms.css) | Hand-written styles for shared `.btn` controls, text fields, selects, checkboxes, option cards and tiles, switches, segmented controls, filter chips, the credential editor and the operation picker. Also owns base form and fieldset styles in `.content` and dialogs, and the shared Astryx TextInput border override used by sign-in. Uses Astryx font weights, border width, zero spacing, focus outline width and the small element size. |
| [tables.css](../src/server/admin/design/tables.css) | Hand-written styles for table wrappers and the people, roles, tools, instances, invitations, providers, rules, tokens, audit, SSH event and session tables, including their stacked narrow layouts and the base table styles for content outside the Astryx root. Uses Astryx font weights, border width, focus outline width and zero spacing. |
| [cards.css](../src/server/admin/design/cards.css) | Hand-written styles for notes, hints and text utilities, card parts, list rows, avatars, tool icons, status dots, page grids, docked record sheets and shared sheet header and body layout, key-value lists, code and copy blocks, vertical and setup steps, disclosures including `.all-fields` summaries, and the tool grid. Also owns the Advanced tool tab's JSON validation note colors within the Astryx root. Uses Astryx font weights, border width and zero spacing. |
| [dialogs.css](../src/server/admin/design/dialogs.css) | Hand-written styles for the `.message` form error box, side sheets with their scrim and footer, native dialogs and their backdrop, the icon circles on signed-out screens, certificate inspection text wrapping, and the signed-out auth screens including their footnote, help disclosure and theme row. Uses Astryx font weights, border width and zero spacing. |
| `src/server/admin/design/ui.ts` | Builds the typed breadcrumb, brand, navigation, account menu and help panel data for the frame. |
| `src/views/frame.tsx` | Renders the frame, including its account menu and Learn disclosure. |
| `src/views/theme-switch.tsx` | Renders the theme switch shared by the frame and auth views. |
| `src/views/icon.tsx` | Owns the shared inline icon catalog and markup. |
| `src/server/admin/design/status.ts` | The status vocabulary: one word and tone per state, the badge and status-dot helpers, and the product display name and mark of each tool. |

The tokens, components, `frame.css`, `forms.css`, `tables.css`, `cards.css` and `dialogs.css` in `src/server/admin/design` are concatenated, in that order, and served from `/admin/assets/style.css`.
The [asset route](../src/server/admin/users.ts) reads `design/frame.css`, `design/forms.css`, `design/tables.css`, `design/cards.css` and `design/dialogs.css` relative to its module at load time, so builds and server bundles must include all five stylesheets at those relative paths.
The build also produces a React and Astryx browser bundle and the Astryx neutral stylesheet, served at `/admin/assets/hydrate.js` and `/admin/assets/astryx.css`.
All pages load the stylesheet; render-seam pages also load the browser bundle.

The frame keeps its legacy surface, text, border and status colors because the Astryx palettes yield different values in light or dark mode.
It keeps the legacy popover shadow because Astryx uses different offsets and opacity.
Font sizes, corner radii, nonzero spacing and layout dimensions retain their baseline values across browser font sizes.
The [frame CSS parity archive](frame-css-parity.zip) contains 96 historical before-and-after screenshot pairs for base revision `64bba2600f9f421d22d67cc445e9cc05582d897d` and the stylesheet served by revision `7c94db0113048f39c255f689710b64841c3214de`.
The archive's `README.txt` records the stylesheet checksums, screenshot comparison at the default root font size and computed token checks at the default and 20px root font sizes.

The form controls keep their legacy surface, text, border and status colors for the same reason.
They keep legacy font sizes, corner radii, nonzero spacing and layout dimensions across browser font sizes.
Small buttons and filter chips use the Astryx small element size for height, and small icon buttons also use it for width.
The `.input.mono` rule in `forms.css` sets the font size with higher specificity than the `.mono` utility in the later `cards.css`.
Astryx puts the `.mono` class on the TextInput wrapper, so `forms.css` applies the monospace font to the nested input.
The [forms CSS parity archive](forms-css-parity.zip) includes before-and-after screenshots from successive extraction revisions, including rendered sign-in and filled monospace fields.
See its `README.txt` for the stylesheet checksums, capture coverage by revision and computed style checks.

The table styles keep their legacy surface, text and border colors, font sizes, corner radii, nonzero spacing, layout dimensions and container and viewport breakpoints.
The extracted rules retain their relative order in `tables.css`, including the narrow-screen rules that were at the end of `components.ts`.
The `.filters` margin reset now sits in the `.filters` rule in `forms.css`; `.card form` keeps its own reset in `components.ts`.
The [tables CSS parity archive](tables-css-parity.zip) includes before-and-after page screenshots and captures with sample rows for tables that the fixture leaves empty.
See the archive's `README.txt` for the stylesheet checksums, exact capture coverage, screenshot comparison results and computed style checks.

The card and layout styles keep their legacy surface, text, border and status colors, font sizes, corner radii, nonzero spacing, layout dimensions and viewport breakpoints.
The extracted rules in `cards.css` preserve the cascade, including the narrow-screen and 1080px layout rules.
The [cards CSS parity archive](cards-css-parity.zip) includes comparisons with the baseline across several stylesheet revisions.
See its `README.txt` for capture coverage by revision, stylesheet checksums, screenshot comparison results and computed style checks.

The dialog and auth styles keep their legacy surface, text, border and status colors, font sizes, corner radii, nonzero spacing, layout dimensions, z-index values and the 760px viewport breakpoint.
The unused `.modal-foot` and `.dialog-actions` rules stay in `components.ts`.
The extracted rules in `dialogs.css` keep their relative order, including the narrow-screen sheet width.
The [dialogs CSS parity archive](dialogs-css-parity.zip) includes before-and-after screenshots of signed-out and signed-in auth pages, side sheets and dialogs with their populated and error states.
The archive lists separate candidate checksums for the original captures and the supplemental comparisons of the pre-hydration sheet, certificate name-change button and SSO sign-out checkbox.
See its `README.txt` for the stylesheet checksums, capture method, screenshot comparison results and computed style checks at the default and 20px root font sizes.

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
`adminChrome()` in `src/server/admin/design/ui.ts` supplies the breadcrumb, brand, administration links, account menu and help panel data that `Frame` renders.
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
The legacy base rules for headings, paragraphs, links, table elements, labels, selects, textareas, buttons and inputs other than checkboxes, radio buttons, hidden and file inputs skip content inside `[data-astryx-root]`.
Tool views render without `legacyHtml` or `legacy-island` markup.
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
- Every icon is an `svg.i` rendered by the `Icon` component in `src/views/icon.tsx`, with its own inline shapes on a 24px grid.
  Pages contain no ad hoc SVG shapes, sprite symbols or `<use>` references.
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
Icons use a 1.75 stroke in `currentColor` and are shown at 16px.

## Legacy components

| Component | Markup | States | Accessibility |
| --- | --- | --- | --- |
| App shell | `appShell()`: `.app`, `.side`, `.main`, `.topbar`, `.content` | Administrator (sidebar), ordinary user (top bar only) | Skip link to `main#main`; sidebar `nav` labelled "Administration" |
| Nav item | `.nav-item`, `.nav-label` | default, hover, current | `aria-current="page"` on the current section |
| Account menu | `.account-menu` with `.popover` | closed, open | Native disclosure; "Signed in as" is announced |
| Learn panel | `.learn` with `.learn-panel` | closed, open | Native disclosure holding the page help |
| Breadcrumb | `.crumbs` | section group, or a parent page link on detail pages | Current page in `strong` |
| Summary card | `.card` with `.summary` | neutral, warning | Label, value and one sentence |
| Page header | `pageHeader()`: `.page-head`, `.actions`; identity variant `.page-head.identity`, `.meta` | title, optional one-line description, actions (at most one primary), identity variant with a lead avatar or `toolIcon(tool, 'lg')` and badges | The page's only `h1`; detail pages name their list page in the breadcrumb |
| Button | `.btn` with `.btn-secondary`, `.btn-ghost`, `.btn-danger-outline` or `.btn-danger`; `.btn-sm`, `.btn-icon`; `.btn-ghost.danger` for a quiet destructive row action | default, hover, focus | Icon-only buttons need `aria-label`; verbs name the result |
| Badge and status | `badge()`, `status()` from `status.ts`: `.badge` with `.ok`, `.warn`, `.err`, `.info`, `.solid`; `.status` with `.dot` | words from the status vocabulary only | The word is always present; the dot is `aria-hidden` |
| Chip | `.chip`, `.chips` | plain, link | Role chips name the grant origin (Direct, SSO rule) where it matters |
| Card | `card()`: `.card`, `.card-head`, `.card-body`, `.card-foot`, `.card-note`; `.card.danger`, `.card.empty` | plain, with header actions, with footer actions, danger zone, empty state | `h2` per card |
| Table | `.tbl` in `.table-wrap`; `.cell-main`, `.row-link`, `.num`, `.actions-cell`, `.stacked`; `.row-links`, `.stack`, `tr.sel`; `pager()` footer | row links, selected row, dimmed row, numeric column, stacked rows below 760px | Real `<table>`; the row link is the first-cell anchor, stretched over the row, not a JavaScript click |
| Field | `field()`: `.field`, `.hint`; `.input`, `.select`, `.input.mono`, `.input.narrow`; `checkOption()`: `.check`; `.options` fieldset | default, focus, invalid, disabled | `label for`; hints linked by `aria-describedby` |
| Callout | `callout()`: `.callout` with `.info`, `.ok`, `.warn`, `.err` | with optional actions and additional detail | `role="status"` by default; blocking errors use `role="alert"` |
| Steps | `.vsteps`, `.vstep` (`.done`, `.current`) | done, current, to do | Ordered list; done steps carry hidden "Done:" text |
| Key-value list | `.kv` | | `<dl>` |
| List row | `.rows`, `.list-row`, `.step-mark` | | Ordered list when the order matters |
| Avatar and tool icon | `.avatar` (e.g., `AccountMenu` in `src/views/frame.tsx`), `.avatar.lg` (`Person` in `src/views/person.tsx`); `toolIcon()`: `.tool-ico`, `.tool-ico.lg`, using a mark from `toolProducts` | sm, lg | Initials and marks are `aria-hidden`; the name is adjacent text |
| Overflow menu | `.more-menu` with `.popover` | closed, open | Native disclosure with `aria-label` on its icon summary |
| Side sheet | `dialog.sheet` with `.sheet-head`, `.sheet-body`, `.sheet-foot`, `.scrim` | See [sheet behavior](#patterns) | Labelled by its heading |
| Option tile | `.tiles`, `.tile`, `.tool-ico` | unchecked, checked | Native checkbox inside its label |
| Inline editor and menu | `.inline-edit`, `.menu` with `.popover` | closed, open | Native disclosure; works without JavaScript |
| Filter row | `.filters`, `.input-wrap`, `.seg`, `.filter`, `.filter.set` | unset (dashed), set (with clear link) | See [Browser administration](admin-guide.md#browser-administration) |
| Docked sheet | `.split`, `.sheet.docked`, `.sheet-head`, `.sheet-body`, `.kv`, `.code`, `.copyfield` | open beside its list; above it below 760px | `aside` labelled by its `h2`; opened by a `?record=` link, so it works without JavaScript |
| Option card | `.options`, `.option` | unchecked, checked | Native radio |
| Code and copy | Copy controls use [`useCopy`](../src/views/copy.ts) in the hydrated React view | Idle, copied, or clipboard access unavailable (the source is selected for manual copying) | `role="status"` announces the copy result |
| Disclosure card | `details.card.disclosure` | closed, open | Native disclosure |
| Dialog | Astryx `Dialog` in [`Confirmation`](../src/views/confirmation.tsx) and [`ReauthDialog`](../src/views/reauth-dialog.tsx) | confirmation tier 2 or 3, identity confirmation | `showModal`, Esc closes, a backdrop press does not, the action confirmation title names the action, focus returns to the control that submitted |
| Toasts | `Toasts` in `src/views/toasts.tsx` on the Astryx toast viewport | none, success, error, conflict with **Reload latest** | A saved success toast appears on the resulting page and is announced politely; an error from a form with no message area of its own is announced assertively and clears on the next submission of a form without its own message area |
| Steps | `steps()`: `ol.steps`, `.step` | done, fail, to do, current | Ordered list; the state is in visually hidden text |
| Segmented control and search | `.seg` with visually hidden radios, `.search`, `.filters` | checked | GET forms; JavaScript may apply them live |
| Switch | `.switch` on a native checkbox, or `.toggle` button holding a decorative `.switch` | off, on, disabled | `role="switch"`; checkboxes save with their form; the Enabled button submits a confirmed change |
| Operation catalogue | `.ops`, `details.ops-group`, `label.op` | collapsed, open, filtered, Delete and Bulk tags | Native disclosures and checkboxes; see [label and risk ownership](#write-operation-labels-and-risk) |
| Credential editor | `CredentialEditor` styled through `[data-credential-editor]` and `[data-credential-field]` | stored secret, required, hidden | Controls have associated labels; `aria-describedby` links their hints |

See [Files](#files) for ownership of base form styles and legacy button variants.

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

The sidebar groups administration into Overview, Access (People, Roles, Invitations), Tools (Tools) and Security (Sign-in & SSO, Audit log).
The current section is derived from the request path.
In the render-seam page frame the sidebar is an Astryx `SideNav`; at 767px and narrower it is replaced by a navigation disclosure in the header.
The header stays one row there, and the recent-auth pill and the colour theme switch move into that disclosure.

## Changing the UI

- Build render-seam views from Astryx components, subject to the constraints above.
- Express new colours or sizes as new tokens, never literals.
