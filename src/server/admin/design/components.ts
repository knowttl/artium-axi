// Component classes from docs/design-system.md. Colours and shared design values come from tokens.ts.
export const components = `
*, *::before, *::after { box-sizing: border-box; }
html, body { background: var(--bg); }
body { margin: 0; color: var(--text); font: var(--fs-base)/1.5 var(--font); -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
a:where(:not([data-astryx-root] *)) { color: var(--text); text-underline-offset: 2px; }
code, pre, kbd { font-family: var(--mono); font-size: 0.92em; }
small { overflow-wrap: anywhere; }
[hidden] { display: none !important; }
a, button, summary, .nav-item, .btn { transition: background-color 120ms, color 120ms, border-color 120ms; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
svg.i { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip { position: absolute; left: 12px; top: -48px; z-index: 100; padding: 8px 12px; border-radius: var(--r-sm); background: var(--primary); color: var(--primary-fg); text-decoration: none; font-size: var(--fs-sm); }
.skip:focus { top: 12px; }

.message { margin: 0; padding: 12px 14px; border: 1px solid var(--err-border); border-radius: var(--r-md); background: var(--err-soft); color: var(--err); font-size: var(--fs-sm); }
.message:empty { display: none; }
.note { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--fs-sm); }

/* Layout helpers for page content */
.hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.list-row .grow strong a { text-decoration: none; }
.list-row .grow strong a:hover { text-decoration: underline; }

/* Vertical steps: an ordered checklist with state in text */
.vsteps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.vstep { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; padding-bottom: 18px; }
.vstep:last-child { padding-bottom: 0; }
.vstep::before { content: ""; position: absolute; left: 11px; top: 26px; bottom: 2px; width: 1px; background: var(--border); }
.vstep:last-child::before { display: none; }
.vstep .mark { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-full); background: var(--bg); color: var(--text-faint); font-size: 11px; }
.vstep .mark svg { width: 13px; height: 13px; vertical-align: 0; }
.vstep.done .mark { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.vstep.current .mark { border-color: var(--text); color: var(--text); font-weight: 600; }
.vstep strong { display: block; font-weight: 500; }
.vstep p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.vstep .copyfield, .vstep .code, .vstep .seg { margin-top: 8px; }

/* Code, copy and key-value list */
.copyblock { position: relative; min-width: 0; }
.copyblock .code { padding-right: 84px; }
.copyblock > .btn { position: absolute; top: 8px; right: 8px; }
.copy-status:empty { display: none; }
.copy-status { color: var(--text-muted); font-size: var(--fs-xs); }

/* Field: label, control, hint */
:where(.content, .auth-card, dialog) .field label { margin: 0; }

/* Tool grid: granted tools with availability */
.tool-grid { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 16px; }
.tool-grid li { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tool-grid strong { display: block; font-size: var(--fs-sm); font-weight: 500; }
.tool-grid .status { font-size: var(--fs-xs); color: var(--text-muted); }

/* Disclosure card: a collapsible section */
.disclosure > summary { list-style: none; cursor: pointer; border-radius: var(--r-lg); }
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure > summary:hover { background: var(--bg-subtle); }
.disclosure > summary > svg:last-child { color: var(--text-faint); }
.disclosure[open] > summary { border-bottom: 1px solid var(--border); border-radius: var(--r-lg) var(--r-lg) 0 0; }
.disclosure[open] > summary > svg:last-child { transform: rotate(180deg); }
[data-copy-scope] > .copy-status { margin: 4px 0 0; }


/* Card and rows */
.list-row { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
.list-row:last-child { border-bottom: 0; }
.list-row .grow { flex: 1; min-width: 0; }
.list-row .grow strong { font-weight: 500; }
.list-row .grow p { margin: 1px 0 0; color: var(--text-muted); font-size: var(--fs-xs); }
.avatar { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: var(--r-full); background: var(--bg-active); color: var(--text-muted); font-size: 11px; font-weight: 600; }

/* Layout */
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) var(--aside-w); gap: 20px; align-items: start; }
.grow { flex: 1; min-width: 0; }

/* More buttons */
.btn-ghost.danger { color: var(--err); }
.btn-ghost.danger:hover { background: var(--err-soft); color: var(--err); }

/* Additions to the shared badge, dot and chip below */
.dot.info { background: var(--info); }
.avatar.lg { width: 48px; height: 48px; font-size: var(--fs-md); }

/* Card parts */
.card-body .list-row { padding: 10px 0; }
.card > form, .card-foot form, .list-row form, .tbl form, .page-head form { margin: 0; }
.card-meta { margin: 0; color: var(--text-faint); font-size: var(--fs-xs); }

/* Table */
.table-wrap { overflow-x: auto; }
.link-rows tbody tr { position: relative; }
.link-rows tbody a:not(.row-chip)::after { content: ""; position: absolute; inset: 0; }
.link-rows tbody a:not(.row-chip):focus-visible { outline: 0; }
.link-rows tbody a:not(.row-chip):focus-visible::after { outline: 2px solid var(--focus); outline-offset: -2px; }
.link-rows tbody tr:hover { background: var(--bg-subtle); }
.link-rows .row-link { color: var(--text); text-decoration: none; }
.link-rows tbody td.num { width: 48px; min-width: 48px; color: var(--text-faint); text-align: right; }
.link-rows tbody tr.dim { opacity: 0.6; }
.link-rows tbody td a.row-chip { position: relative; z-index: 1; }
.roles-list .count { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.roles-list tbody tr:last-child th { border-bottom: 0; }
.tools-list th, .tools-list td { max-width: none; overflow: visible; }
@media (min-width: 761px) { .tools-list th, .tools-list td { white-space: nowrap; overflow-wrap: normal; word-break: normal; } }
.tools-list tbody tr:last-child th, .tools-list tbody tr:last-child td { border-bottom: 0; }
.astryx-card:has(.instances-list) { overflow: visible; }
.instances-list { container-type: inline-size; }
.instances-list th, .instances-list td { max-width: none; overflow: visible; }
.instances-list tbody th { white-space: normal; overflow-wrap: anywhere; }
@container (width >= 900px) { .instances-list tbody th { min-width: 12rem; } .instances-list td:not([data-label="Endpoint"]) { white-space: nowrap; overflow-wrap: normal; word-break: normal; } }
.instances-list td[data-label="Endpoint"], .instances-list td[data-label="SHA-256"], .instances-list td[data-label="Expires"] { overflow-wrap: anywhere; white-space: normal; }
.instances-list td[data-label="Endpoint"] { min-width: 12rem; }
.instances-list td[data-label="SHA-256"] { max-width: 22rem; }
.instances-list td[data-label="Expires"] { min-width: 11rem; }
.instances-list td.actions-cell { text-align: right; }
.instances-list tbody tr:last-child th, .instances-list tbody tr:last-child td { border-bottom: 0; }
.invitations-list th, .invitations-list td { max-width: none; overflow: visible; }
@media (min-width: 761px) { .invitations-list td:first-child, .invitations-list td:last-child, .invitations-list code { white-space: nowrap; overflow-wrap: normal; word-break: normal; } }
.invitations-list tbody tr:last-child td { border-bottom: 0; }
.providers-list th, .providers-list td { max-width: none; overflow: visible; }
.providers-list code { overflow-wrap: anywhere; }
.providers-list tbody tr:last-child td { border-bottom: 0; }
.astryx-card:has(.rules-list) { overflow: visible; }
.rules-list th, .rules-list td { min-width: 0; max-width: none; overflow: visible; overflow-wrap: anywhere; white-space: normal; }
.rules-list .rule-grants > * { min-width: 0; }
@media (min-width: 761px) { .rules-list th:nth-child(3), .rules-list td:nth-child(3) { white-space: nowrap; overflow-wrap: normal; } .rules-list td.actions-cell { width: 1%; } }
.rules-list tbody tr:last-child th, .rules-list tbody tr:last-child td { border-bottom: 0; }
.tokens-list { container-type: inline-size; }
.tokens-list th, .tokens-list td { min-width: 0; max-width: none; overflow: visible; overflow-wrap: anywhere; white-space: normal; vertical-align: top; }
.tokens-list th *, .tokens-list td * { min-width: 0; overflow-wrap: anywhere; }
.token-scope { margin: 0; padding-left: 1.2em; }
.astryx-button.revoke { color: var(--err); }
.astryx-button.revoke:hover { background: var(--err-soft); }
@container (width >= 900px) { .tokens-list td[data-label="Creator"] { min-width: 14rem; } .tokens-list td[data-label="Expires"], .tokens-list td.actions-cell { white-space: nowrap; overflow-wrap: normal; } .tokens-list td.actions-cell { width: 1%; } }
.tokens-list tbody tr:last-child th, .tokens-list tbody tr:last-child td { border-bottom: 0; }
@container (width < 900px) {
  .instances-list thead, .tokens-list thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .instances-list tbody tr, .tokens-list tbody tr { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .instances-list tbody tr:last-child, .tokens-list tbody tr:last-child { border-bottom: 0; }
  .instances-list tbody th, .instances-list tbody td, .tokens-list tbody th, .tokens-list tbody td { display: block; width: auto; max-width: none; padding: 0; border: 0; }
  .instances-list tbody th, .tokens-list tbody th, .tokens-list tbody td.token-access, .instances-list tbody td.actions-cell { flex-basis: 100%; }
  .tokens-list tbody td.actions-cell { margin-left: auto; }
  .instances-list tbody td.actions-cell { text-align: left; }
  .instances-list tbody td[data-label]::before, .tokens-list tbody td[data-label]::before { content: attr(data-label) " "; color: var(--text-faint); }
}
.audit-list th, .audit-list td { min-width: 0; max-width: none; overflow: visible; overflow-wrap: anywhere; white-space: normal; vertical-align: top; }
.audit-list tbody th { font-weight: 400; }
.audit-list tbody tr.sel { background: var(--bg-muted); }
.ssh-events { container-type: inline-size; }
.ssh-events th, .ssh-events td { min-width: 0; max-width: none; overflow: visible; overflow-wrap: break-word; white-space: normal; vertical-align: top; }
.ssh-events tbody th { font-weight: 400; }
.ssh-events tbody th time { white-space: nowrap; }
.ssh-events tbody tr:last-child th, .ssh-events tbody tr:last-child td { border-bottom: 0; }
@container (min-width: 760px) {
  .ssh-events td[data-label="Event"] { min-width: 6rem; } .ssh-events td.connection-cell { min-width: 11rem; }
  .ssh-events td[data-label="Host"] { min-width: 8rem; } .ssh-events td[data-label="User"] { min-width: 10rem; } .ssh-events td[data-label="Request ID"] { min-width: 10rem; }
  .ssh-events td[data-label="Outcome"] { min-width: 11rem; } .ssh-events td[data-label="Account type"] { min-width: 7rem; }
  .ssh-events td[data-label="Person"] { min-width: 10rem; } .ssh-events td[data-label="Host use"], .ssh-events td[data-label="Sudo account"] { min-width: 8rem; }
  .ssh-events td[data-label="Username"], .ssh-events td[data-label="Credential"] { min-width: 11rem; }
}
@container (width < 760px) {
  .ssh-events thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .ssh-events tbody tr { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .ssh-events tbody tr:last-child { border-bottom: 0; }
  .ssh-events tbody th, .ssh-events tbody td { display: block; width: auto; padding: 0; border: 0; }
  .ssh-events tbody td { flex: none; max-width: 100%; }
  .ssh-events tbody td.connection-cell, .ssh-events tbody th { flex-basis: 100%; }
  .ssh-events tbody td[data-label]::before { content: attr(data-label) " "; color: var(--text-faint); }
  .ssh-events tbody td[data-label="Event"] > * { display: inline-flex; }
}
.event-detail { color: var(--text-muted); font-size: var(--fs-xs); }
.ssh-limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); gap: 16px; }
.audit-list tbody tr:last-child th, .audit-list tbody tr:last-child td { border-bottom: 0; }
.audit-list { container-type: inline-size; }
@container (min-width: 880px) { .audit-list tbody th { white-space: nowrap; overflow-wrap: normal; } .audit-list td[data-label="Event"] { min-width: 8rem; }
  .audit-list td[data-label="Actor"], .audit-list td[data-label="Instance"] { min-width: 7rem; } .audit-list td[data-label="Tool"] { min-width: 6rem; } }
@container (width < 880px) {
  .audit-list thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .audit-list tbody tr { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .audit-list tbody tr:last-child { border-bottom: 0; }
  .audit-list tbody th, .audit-list tbody td { display: block; width: auto; padding: 0; border: 0; }
  .audit-list tbody td { flex: none; max-width: 100%; }
  .audit-list tbody th { flex-basis: 100%; }
  .audit-list tbody td[data-label]::before { content: attr(data-label) " "; color: var(--text-faint); }
}

/* The filter row itself is shared below; the People count note sits at its end */
.filters .count-note { margin-left: auto; color: var(--text-faint); font-size: var(--fs-xs); }

/* Fields */
.field > label, .field-label { margin: 0; font-size: var(--fs-sm); font-weight: 500; }
.field .hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.copy-status { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.copy-status:empty { display: none; }

/* Vertical steps */
.vsteps { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.vstep { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; padding-bottom: 18px; }
.vstep:last-child { padding-bottom: 0; }
.vstep::before { content: ""; position: absolute; left: 11px; top: 26px; bottom: 2px; width: 1px; background: var(--border); }
.vstep:last-child::before { display: none; }
.vstep .mark { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-full); background: var(--bg); color: var(--text-faint); font-size: 11px; }
.vstep .mark svg { width: 13px; height: 13px; vertical-align: 0; }
.vstep.done .mark { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.vstep.current .mark { border-color: var(--text); color: var(--text); font-weight: 600; }
.vstep strong { display: block; font-weight: 500; }
.vstep p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.vstep .btn { margin-top: 8px; }

/* Side sheet and scrim */
dialog.sheet { position: fixed; inset: 0 0 0 auto; z-index: 60; width: 440px; max-width: 100%; height: 100%; max-height: 100%; margin: 0; padding: 0; border: 0; border-left: 1px solid var(--border); border-radius: 0; box-shadow: var(--shadow-pop); }
dialog.sheet[open] { display: flex; flex-direction: column; }
dialog.sheet > form { display: flex; flex-direction: column; flex: 1; min-height: 0; margin: 0; }
.scrim { position: fixed; inset: 0; z-index: 55; background: var(--overlay); }
dialog.sheet .sheet-head { padding: 18px 20px; }
dialog.sheet .sheet-body { flex: 1; overflow: auto; padding: 20px; }
.sheet-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); background: var(--bg-subtle); }

/* Overflow menu: a native disclosure like the account menu */
.more-menu { position: relative; margin: 0; padding: 0; border: 0; }
.more-menu summary { list-style: none; }
.more-menu summary::-webkit-details-marker { display: none; }
.more-menu[open] > summary { background: var(--bg-hover); }
.more-menu .popover { right: 0; top: calc(100% + 6px); }

/* Dialog (native) */
dialog { width: 480px; max-width: calc(100% - 32px); max-height: calc(100% - 48px); overflow: auto; padding: 24px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-pop); }
dialog::backdrop { background: var(--overlay); }
dialog h2 { margin: 0 0 6px; font-size: var(--fs-md); font-weight: 600; }
.ico-circle { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: var(--r-full); background: var(--bg-muted); color: var(--text-muted); }
.ico-circle.ok { background: var(--ok-soft); color: var(--ok); }
.ico-circle.warn { background: var(--warn-soft); color: var(--warn); }
.modal-foot, .dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.modal-foot { margin: 0; padding: 14px 22px 18px; }
#certificate-inspection, [data-trusted-certificates] { overflow-wrap: anywhere; }
#certificate-inspection [data-use-certificate-name] { white-space: normal; height: auto; min-height: var(--ctl-h); text-align: left; }

/* Auth card: signed-out screens */
.auth { min-height: 100vh; display: grid; place-items: center; padding: 40px 16px; background: var(--bg-subtle); }
.auth-wrap { width: 100%; max-width: 380px; }
.auth-foot { margin: 14px 0 0; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; }
.auth-foot .check { justify-content: center; align-items: center; min-height: var(--ctl-h-sm); }
.auth-help { margin-top: 14px; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; border: 0; padding: 0; }
.auth-help p { text-align: left; }

/* Base elements, so pages without their own components yet stay readable inside the shell */
:where(.content, .auth-card, dialog) :where(h2):where(:not([data-astryx-root] *)) { margin: 0 0 8px; font-size: var(--fs-md); font-weight: 600; letter-spacing: -0.01em; }
:where(.content, dialog) :where(h3) { margin: 16px 0 6px; font-size: var(--fs-base); font-weight: 600; }
:where(.content, .auth-card, dialog) :where(a):where(:not([data-astryx-root] *)) { color: var(--text); }
:where(.content, .auth-card, dialog) :where(label):where(:not([data-astryx-root] *)) { display: block; margin: 10px 0; font-size: var(--fs-sm); font-weight: 500; }
:where(.content, .auth-card, dialog) :where(input:not([type=checkbox], [type=radio], [type=hidden], [type=file]), select, textarea):where(:not([data-astryx-root] *)) { display: block; width: 100%; max-width: 420px; height: var(--ctl-h); margin-top: 6px; padding: 0 10px; color: var(--text); background: var(--bg); border: 1px solid var(--control); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); font-weight: 400; }
:where(.content, .auth-card, dialog) :where(textarea):where(:not([data-astryx-root] *)) { max-width: none; height: auto; min-height: 96px; padding: 8px 10px; font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.6; }
:where(.content, .auth-card, dialog) :where(input:disabled, select:disabled, textarea:disabled):where(:not([data-astryx-root] *)) { background: var(--bg-muted); color: var(--text-faint); }
:where(.content, .auth-card, dialog) :where(button):where(:not([data-astryx-root] *)) { display: inline-flex; align-items: center; gap: 6px; height: var(--ctl-h); padding: 0 12px; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); font-weight: 500; cursor: pointer; }
:where(.content, .auth-card, dialog) :where(button):where(:not([data-astryx-root] *)):hover { background: var(--bg-hover); }
:where(.content, .auth-card, dialog) :where(button:disabled):where(:not([data-astryx-root] *)) { opacity: 0.5; cursor: wait; }
:where(.content, dialog) :where(details) { margin: 12px 0; padding-top: 10px; border-top: 1px solid var(--border); }
:where(.content, dialog, .auth-help) :where(summary) { cursor: pointer; font-size: var(--fs-sm); font-weight: 500; }
:where(.content, dialog) :where(pre:empty) { display: none; }
:where(.content, dialog) :where(label small) { display: block; margin-top: 4px; font-weight: 400; }
:where(.content, dialog) :where(pre) { overflow-x: auto; padding: 12px 14px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--r-md); font-size: var(--fs-xs); line-height: 1.7; }
:where(.content, dialog) :where(table):where(:not([data-astryx-root] *)) { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); text-align: left; }
:where(.content, dialog) :where(caption) { padding: 10px 14px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--border); }
:where(.content, dialog) :where(th, td):where(:not([data-astryx-root] *)) { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: break-word; }
:where(.content, dialog) :where(thead th):where(:not([data-astryx-root] *)) { background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
:where(.content, dialog) :where(tbody th) { font-weight: 500; }
:where(.content, dialog) :where(tbody tr:last-child) > *:where(:not([data-astryx-root] *)) { border-bottom: 0; }
.session-table time, .session-table button, .session-table code { white-space: nowrap; }
.session-table th, .session-table td { max-width: none; overflow: visible; }
.session-list { container-type: inline-size; }
@container (width < 760px) {
  .session-table thead { display: none; }
  .session-table tr { display: block; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .session-table tbody tr:last-child { border-bottom: 0; }
  .session-table td { display: block; padding: 3px 14px; border: 0; }
  .session-table td[data-label]::before { content: attr(data-label) ": "; color: var(--text-faint); }
}

/* Page header actions and record metadata */
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.mono { font-family: var(--mono); font-size: var(--fs-xs); }

/* Badge, status dot and chips: words carry the state, dots are decorative */
.dot { width: 7px; height: 7px; flex: none; display: inline-block; border-radius: var(--r-full); background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.dot.info { background: var(--info); }
.dot.off { background: var(--control); }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); white-space: nowrap; }

/* Card parts */
.card-body { padding: 18px; }
.card-body > :first-child { margin-top: 0; }
.card-body > :last-child { margin-bottom: 0; }
.card-body h3 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
.card-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); }
.card-foot p { margin: 0; }
.card-note { margin: 0; display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-xs); }
.card form, .filters { margin: 0; }
.list-row h2 { margin: 0; font-size: var(--fs-sm); font-weight: 500; }

.tool-ico { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: -0.02em; }
.tool-ico.lg { width: 44px; height: 44px; border-radius: 10px; font-size: 15px; }

/* Inline editor and menus: native disclosures holding a popover */
.inline-edit, .menu { position: relative; margin: 0; padding: 0; border: 0; }
.menu { flex: none; }
.inline-edit > summary, .menu > summary, .all-fields > summary { list-style: none; }
.inline-edit > summary::-webkit-details-marker, .menu > summary::-webkit-details-marker, .all-fields > summary::-webkit-details-marker { display: none; }
.inline-edit[open] > summary, .menu[open] > summary { background: var(--bg-hover); color: var(--text); }
.menu .popover { right: 0; top: calc(100% + 6px); min-width: 260px; }
.theme-row { display: flex; justify-content: center; padding: 0 8px 4px; }
.auth-wrap > .theme-row { margin-top: 14px; }
.popover-note { margin: 0; padding: 6px 8px 8px; color: var(--text-muted); font-size: var(--fs-xs); }

.audit-toolbar { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 12px; }
.audit-toolbar > .filters { flex: 1 1 32rem; min-width: 0; }
.audit-toolbar > .menu { margin-left: auto; }

/* Docked side sheet: record detail beside its list */
.split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
.split.has-aside { grid-template-columns: minmax(0, 1fr) var(--aside-w); }
.split-main { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.sheet:not(dialog) { min-width: 0; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); }
.sheet.docked { position: sticky; top: calc(var(--topbar-h) + 16px); max-height: calc(100vh - var(--topbar-h) - 32px); overflow: auto; }
.sheet-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.sheet-head h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; }
.sheet-head p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.sheet-head .btn { margin-left: auto; }
.sheet-body { padding: 18px; display: flex; flex-direction: column; gap: 18px; }
.sheet-body h3 { margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 500; }
.kv { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: var(--fs-sm); }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.code { position: relative; margin: 0; padding: 12px 14px; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--code-bg); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.copyfield input:not(.input) { min-width: 0; max-width: none; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); }
.all-fields { margin: 0; padding: 0; border: 0; }
.all-fields[open] > summary { margin-bottom: 14px; }
.execution { min-width: 0; }
.execution + .execution { padding-top: 20px; border-top: 1px solid var(--border); }
.execution dd, .execution dt { min-width: 0; overflow-wrap: anywhere; }
.sheet.docked dd, .sheet.docked dt { min-width: 0; overflow-wrap: anywhere; }
.all-fields .kv { font-size: var(--fs-xs); }

@media (max-width: 1080px) {
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

/* Badge and status: words from status.ts; the dot is decorative */
.status svg.i { vertical-align: 0; }
.status.warn { color: var(--warn); }
.status.neutral { color: var(--text-muted); }
.note:empty { display: none; }

/* Card parts */
form.card, .card-foot form, .card-head form { margin: 0; }

/* Table */
.tool-ico.lg { width: 44px; height: 44px; border-radius: 10px; font-size: 15px; }

/* Steps: state is in the text, the mark is decorative */
.steps { margin: 0; padding: 0; list-style: none; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; }
.step { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-right: 1px solid var(--border); background: var(--bg); font-size: var(--fs-sm); }
.step:last-child { border-right: 0; }
.step b { display: block; font-weight: 500; }
.step > div > span { color: var(--text-muted); font-size: var(--fs-xs); }
.step .mark { width: 20px; height: 20px; flex: none; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-full); color: var(--text-faint); font-size: 11px; }
.step .mark svg.i { width: 12px; height: 12px; vertical-align: 0; stroke-width: 2.5; }
.step.done .mark { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.step.fail .mark { background: var(--err); border-color: var(--err); color: var(--bg); }
.step.current { background: var(--bg-subtle); }

:where(.card, [data-astryx-root]) .note[data-valid="true"] { color: var(--ok); }
:where(.card, [data-astryx-root]) .note[data-valid="false"] { color: var(--err); }

/* Narrow screens: the sidebar moves behind a menu button and works without JavaScript */
@media (max-width: 760px) {
  .people-list thead, .invitations-list thead, .providers-list thead { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .people-list tbody tr, .invitations-list tbody tr, .providers-list tbody tr { display: block; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .people-list tbody tr:last-child, .invitations-list tbody tr:last-child, .providers-list tbody tr:last-child { border-bottom: 0; }
  .people-list tbody th, .people-list tbody td, .invitations-list tbody td, .providers-list tbody td { display: block; width: auto; max-width: none; padding: 3px 14px; border: 0; text-align: left; }
  .people-list tbody td.num { position: absolute; top: 10px; right: 0; width: auto; min-width: 0; pointer-events: none; }
  dialog.sheet { width: 100%; border-left: 0; }
  .list-row { flex-wrap: wrap; }
  .list-row .grow { min-width: 60%; }
  .list-row .btn { margin-left: 36px; }
  .grid2, .tool-grid { grid-template-columns: minmax(0, 1fr); }
  .split.has-aside { grid-template-columns: minmax(0, 1fr); }
  .sheet.docked { position: static; max-height: none; order: -1; }
  .roles-list thead, .tools-list thead, .rules-list thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .roles-list tbody tr, .tools-list tbody tr, .rules-list tbody tr { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .roles-list tbody tr:last-child, .tools-list tbody tr:last-child, .rules-list tbody tr:last-child { border-bottom: 0; }
  .roles-list tbody th, .roles-list tbody td, .tools-list tbody th, .tools-list tbody td, .rules-list tbody th, .rules-list tbody td { display: block; width: auto; max-width: none; padding: 0; border: 0; }
  .roles-list tbody th, .tools-list tbody th, .rules-list tbody th, .rules-list tbody td.rule-grants { flex-basis: 100%; }
  .rules-list tbody td.actions-cell { margin-left: auto; }
  .roles-list tbody td[data-label]::before, .tools-list tbody td[data-label]::before { content: attr(data-label) " "; color: var(--text-faint); }
  .roles-list tbody td.num { display: none; }
  .steps { grid-auto-flow: row; }
  .step { border-right: 0; border-bottom: 1px solid var(--border); }
  .step:last-child { border-bottom: 0; }
}
`
