// Component classes from docs/design-system.md. Colours and shared design values come from tokens.ts.
export const components = `
*, *::before, *::after { box-sizing: border-box; }
html, body { background: var(--bg); }
body { margin: 0; color: var(--text); font: var(--fs-base)/1.5 var(--font); -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
a { color: var(--text); text-underline-offset: 2px; }
code, pre, kbd { font-family: var(--mono); font-size: 0.92em; }
small { overflow-wrap: anywhere; }
[hidden] { display: none !important; }
a, button, summary, .nav-item, .btn { transition: background-color 120ms, color 120ms, border-color 120ms; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
svg.i { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip { position: absolute; left: 12px; top: -48px; z-index: 100; padding: 8px 12px; border-radius: var(--r-sm); background: var(--primary); color: var(--primary-fg); text-decoration: none; font-size: var(--fs-sm); }
.skip:focus { top: 12px; }

/* App shell */
.app { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); min-height: 100vh; }
.app.plain { display: block; }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 12px 10px; background: var(--bg-subtle); border-right: 1px solid var(--border); }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.side-head { display: flex; align-items: center; }
.btn.side-close, .btn.menu-open { display: none; }
.brand { display: flex; align-items: center; gap: 8px; padding: 6px 8px 14px; color: var(--text); font-weight: 650; letter-spacing: -0.01em; text-decoration: none; }
.topbar .brand { padding: 0; }
.logo { width: 22px; height: 22px; border-radius: var(--r-sm); background: var(--text); color: var(--bg); display: grid; place-items: center; font-size: var(--fs-xs); font-weight: 700; }
.nav-label { margin: 0; padding: 14px 8px 4px; font-size: 11px; font-weight: 600; color: var(--text-faint); letter-spacing: 0.02em; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--r-sm); color: var(--text-muted); text-decoration: none; font-size: var(--fs-sm); font-weight: 500; }
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item[aria-current="page"] { background: var(--bg-active); color: var(--text); }
.side-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); }
.main { display: flex; flex-direction: column; min-width: 0; }
.topbar { position: sticky; top: 0; z-index: 10; height: var(--topbar-h); display: flex; align-items: center; gap: 12px; padding: 0 24px; background: var(--bg); border-bottom: 1px solid var(--border); }
.topbar .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.crumbs { margin: 0; min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-muted); white-space: nowrap; }
.crumbs strong { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.crumbs .sep { color: var(--text-faint); }
.crumbs a { color: var(--text-muted); text-decoration: none; }
.crumbs a:hover { color: var(--text); }
.unlock { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border: 1px solid var(--border); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; }
.unlock.on svg { color: var(--ok); }
.unlock.off { color: var(--warn); border-color: var(--warn-border); background: var(--warn-soft); }
.content { width: 100%; max-width: var(--content-max); padding: 28px var(--gutter) 40px; display: flex; flex-direction: column; gap: 20px; }
.content:focus { outline: none; }
.content.narrow { max-width: var(--content-narrow); margin: 0 auto; }
.page-head { display: flex; align-items: flex-start; gap: 16px; }
.page-head h1 { margin: 0; font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; }
.page-head p { margin: 4px 0 0; max-width: 640px; color: var(--text-muted); }
.message { margin: 0; padding: 12px 14px; border: 1px solid var(--err-border); border-radius: var(--r-md); background: var(--err-soft); color: var(--err); font-size: var(--fs-sm); }
.message:empty { display: none; }
.note { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--fs-sm); }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--ctl-h); padding: 0 12px; border: 1px solid var(--transparent); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); font-weight: 500; white-space: nowrap; text-decoration: none; cursor: pointer; }
.btn-primary { background: var(--primary); color: var(--primary-fg); }
.btn-primary:hover { background: var(--primary-hover); }
.btn-secondary { background: var(--bg); color: var(--text); border-color: var(--border-strong); }
.btn-secondary:hover { background: var(--bg-hover); }
.btn-ghost { background: var(--transparent); color: var(--text-muted); }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text); }
.btn-sm { height: var(--ctl-h-sm); padding: 0 10px; font-size: var(--fs-xs); }
.btn-icon { width: var(--ctl-h); padding: 0; }
.btn-icon.btn-sm { width: var(--ctl-h-sm); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Card and rows */
.card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); }
.card-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.card-head h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; letter-spacing: -0.01em; }
.card-head p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.rows { margin: 0; padding: 0; list-style: none; }
.list-row { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
.list-row:last-child { border-bottom: 0; }
.list-row .grow { flex: 1; min-width: 0; }
.list-row .grow strong { font-weight: 500; }
.list-row .grow p { margin: 1px 0 0; color: var(--text-muted); font-size: var(--fs-xs); }
.step-mark { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-full); color: var(--text-muted); font-size: 11px; font-weight: 600; }
.avatar { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: var(--r-full); background: var(--bg-active); color: var(--text-muted); font-size: 11px; font-weight: 600; }
.check { display: flex; gap: 10px; align-items: flex-start; font-size: var(--fs-sm); }
.check input { margin: 3px 0 0; accent-color: var(--primary); width: 15px; height: 15px; }

/* Popover menu (account) and Learn panel, both native disclosures */
.account-menu, .learn { position: relative; }
.account-menu summary, .learn summary { list-style: none; }
.account-menu summary::-webkit-details-marker, .learn summary::-webkit-details-marker { display: none; }
.account-menu summary { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: var(--r-sm); cursor: pointer; font-size: var(--fs-sm); }
.account-menu summary:hover, .account-menu[open] summary { background: var(--bg-hover); }
.account-menu .who { min-width: 0; flex: 1; display: flex; flex-direction: column; line-height: 1.35; }
.account-menu .who strong { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-menu .who > span:last-child { color: var(--text-faint); font-size: var(--fs-xs); }
.account-menu summary > svg { color: var(--text-faint); }
.popover { position: absolute; z-index: 30; min-width: 220px; padding: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-md); box-shadow: var(--shadow-pop); font-size: var(--fs-sm); }
.account-menu.up .popover { left: 0; right: 0; bottom: calc(100% + 6px); }
.account-menu.down .popover { right: 0; top: calc(100% + 6px); }
.popover a, .popover .btn { border: 0; display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: 8px; height: auto; padding: 6px 8px; border-radius: var(--r-sm); color: var(--text); font-size: var(--fs-sm); text-decoration: none; }
.popover a:hover, .popover .btn:hover { background: var(--bg-hover); }
.popover a[aria-current="page"] { background: var(--bg-muted); }
.popover hr { margin: 4px 0; border: 0; border-top: 1px solid var(--border); }
.popover form { margin: 0; }
.popover .check { padding: 6px 8px; color: var(--text-muted); font-size: var(--fs-xs); }
.learn-panel { position: absolute; z-index: 30; right: 0; top: calc(100% + 6px); width: min(var(--aside-w), calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow-y: auto; padding: 16px 18px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-pop); color: var(--text-muted); font-size: var(--fs-sm); }
.learn-panel h2 { margin: 0 0 8px; color: var(--text); font-size: var(--fs-base); font-weight: 600; }
.learn-panel p { margin: 0 0 10px; }
.learn-panel p:last-child { margin-bottom: 0; }
.learn[open] > summary { background: var(--bg-hover); color: var(--text); }

/* Dialog (native) */
dialog { width: 480px; max-width: calc(100% - 32px); max-height: calc(100% - 48px); overflow: auto; padding: 24px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-pop); }
dialog::backdrop { background: var(--overlay); }
dialog h2 { margin: 0 0 6px; font-size: var(--fs-md); font-weight: 600; }
dialog.modal { width: 460px; padding: 0; }
.modal-body { padding: 20px 22px 8px; }
.modal-body p { margin: 0 0 12px; color: var(--text-muted); font-size: var(--fs-sm); }
.modal-foot, .dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.modal-foot { padding: 14px 22px 18px; }
.modal-error { margin: 0 22px; color: var(--err); font-size: var(--fs-sm); }
.modal-error:empty { display: none; }
#certificate-inspection, [data-trusted-certificates] { overflow-wrap: anywhere; }

/* Auth card: signed-out screens */
.auth { min-height: 100vh; display: grid; place-items: center; padding: 40px 16px; background: var(--bg-subtle); }
.auth-wrap { width: 100%; max-width: 380px; }
.auth-card { display: flex; flex-direction: column; gap: 16px; padding: 28px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); }
.auth-card .brand { padding: 0; }
.auth-card .page-head h1 { font-size: var(--fs-lg); }
.auth-card > p { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
.auth-card form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.auth-card form > p { margin: 0; }
.auth-card :where(form > button) { width: 100%; justify-content: center;background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.auth-card :where(form > button):hover { background: var(--primary-hover); }
.auth-help { margin-top: 14px; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; border: 0; padding: 0; }
.auth-help p { text-align: left; }

/* Base elements, so pages without their own components yet stay readable inside the shell */
:where(.content, .auth-card, dialog) :where(h2) { margin: 0 0 8px; font-size: var(--fs-md); font-weight: 600; letter-spacing: -0.01em; }
:where(.content, dialog) :where(h3) { margin: 16px 0 6px; font-size: var(--fs-base); font-weight: 600; }
:where(.content) :where(p) { margin: 0 0 10px; }
:where(.content) > :where(p) { margin: 0; }
:where(.content) > :where(section:not(.card)), :where(.content) :where(section section) { padding: 18px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); }
:where(.content) :where(section section) { margin: 16px 0; }
:where(.content, .auth-card, dialog) :where(a) { color: var(--text); }
:where(.content, dialog) :where(form) { margin: 12px 0; }
:where(.content, .auth-card, dialog) :where(label) { display: block; margin: 10px 0; font-size: var(--fs-sm); font-weight: 500; }
:where(.content, .auth-card, dialog) :where(input:not([type=checkbox], [type=radio], [type=hidden], [type=file]), select, textarea) { display: block; width: 100%; max-width: 420px; height: var(--ctl-h); margin-top: 6px; padding: 0 10px; color: var(--text); background: var(--bg); border: 1px solid var(--control); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); font-weight: 400; }
:where(.content, .auth-card, dialog) :where(textarea) { max-width: none; height: auto; min-height: 96px; padding: 8px 10px; font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.6; }
:where(.content, .auth-card, dialog) :where(input:disabled, select:disabled, textarea:disabled) { background: var(--bg-muted); color: var(--text-faint); }
:where(.content, .auth-card, dialog) :where(input[type=checkbox], input[type=radio]) { accent-color: var(--primary); width: 15px; height: 15px; vertical-align: -2px; margin: 0 6px 0 0; }
:where(.content, .auth-card, dialog) :where(input[type=file]) { display: block; margin-top: 6px; font-size: var(--fs-sm); }
:where(.content, .auth-card, dialog) :where(button) { display: inline-flex; align-items: center; gap: 6px; height: var(--ctl-h); padding: 0 12px; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); font-weight: 500; cursor: pointer; }
:where(.content, .auth-card, dialog) :where(button):hover { background: var(--bg-hover); }
:where(.content, .auth-card, dialog) :where(button:disabled) { opacity: 0.5; cursor: wait; }
:where(.content, dialog) :where(fieldset) { margin: 12px 0; padding: 8px 14px; border: 1px solid var(--border); border-radius: var(--r-md); }
:where(.content, dialog) :where(legend) { padding: 0 4px; font-size: var(--fs-sm); font-weight: 600; }
:where(.content, dialog) :where(fieldset label) { font-weight: 400; margin: 6px 0; }
:where(.content, dialog) :where(details) { margin: 12px 0; padding-top: 10px; border-top: 1px solid var(--border); }
:where(.content, dialog, .auth-help) :where(summary) { cursor: pointer; font-size: var(--fs-sm); font-weight: 500; }
:where(.content, dialog) :where(pre:empty) { display: none; }
:where(.content, dialog) :where(form p, fieldset p, label small) { color: var(--text-muted); font-size: var(--fs-xs); }
:where(.content, dialog) :where(label small) { display: block; margin-top: 4px; font-weight: 400; }
:where(.content, dialog) :where(pre) { overflow-x: auto; padding: 12px 14px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--r-md); font-size: var(--fs-xs); line-height: 1.7; }
:where(.content, dialog) :where([role=alert]) { color: var(--err); }
:where(.content, dialog) :where(.action-help) { margin-top: 8px; font-size: var(--fs-xs); color: var(--text-muted); border: 0; padding: 0; }
.table-scroll { max-width: 100%; margin: 12px 0; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); }
:where(.content, dialog) :where(table) { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); text-align: left; }
:where(.content, dialog) :where(caption) { padding: 10px 14px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--border); }
:where(.content, dialog) :where(th, td) { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: break-word; }
:where(.content, dialog) :where(thead th) { background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
:where(.content, dialog) :where(tbody th) { font-weight: 500; }
:where(.content, dialog) :where(tbody tr:last-child) > * { border-bottom: 0; }
.session-table time, .session-table button { white-space: nowrap; }

/* Page header actions and record metadata */
.page-head .actions { margin-left: auto; display: flex; gap: 8px; flex: none; }
.meta-line { color: var(--text-faint); font-size: var(--fs-xs); }
.meta-line p { margin: 0; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.mono { font-family: var(--mono); font-size: var(--fs-xs); }

/* Danger buttons */
.btn-danger { background: var(--danger-solid); color: var(--danger-fg); }
.btn-danger:hover { background: var(--danger-solid); }
.btn-danger-outline { background: var(--bg); color: var(--err); border-color: var(--err-border); }
.btn-danger-outline:hover { background: var(--err-soft); }
.btn[aria-disabled="true"] { opacity: 0.5; cursor: default; pointer-events: none; }

/* Badge, status dot and chips: words carry the state, dots are decorative */
.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; vertical-align: middle; }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-border); }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-border); }
.badge.err { color: var(--err); background: var(--err-soft); border-color: var(--err-border); }
.badge.info { color: var(--info); background: var(--info-soft); border-color: var(--info-border); }
.dot { width: 7px; height: 7px; flex: none; display: inline-block; border-radius: var(--r-full); background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.dot.off { background: var(--control); }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); white-space: nowrap; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: var(--r-sm); background: var(--bg-muted); color: var(--text); font-size: var(--fs-xs); white-space: nowrap; }

/* Card parts */
.card-body { padding: 18px; }
.card-body > :last-child { margin-bottom: 0; }
.card-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); }
.card-foot .actions { margin-left: auto; display: flex; gap: 8px; }
.card-note { margin: 0; display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-xs); }
.card form, .filters, dialog.modal form { margin: 0; }
.card.danger { border-color: var(--err-border); }
.card.empty { padding: 32px 24px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.card.empty h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.card.empty p { margin: 0 0 8px; color: var(--text-muted); font-size: var(--fs-sm); }
.list-row h2 { margin: 0; font-size: var(--fs-sm); font-weight: 500; }

/* Table: real rows whose first-cell link covers the row */
.tbl-scroll { overflow-x: auto; border-radius: var(--r-lg) var(--r-lg) 0 0; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); text-align: left; }
.tbl th, .tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl thead th { padding: 8px 14px; background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
.tbl thead th:first-child { border-top-left-radius: var(--r-lg); }
.tbl thead th:last-child { border-top-right-radius: var(--r-lg); }
.tbl tbody th { font-weight: 500; }
.tbl tbody tr:last-child > * { border-bottom: 0; }
.tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tbl a { text-decoration: none; }
.row-links tbody tr { position: relative; }
.row-links tbody tr:hover, .tbl tr.sel { background: var(--bg-subtle); }
.tbl tr.sel { background: var(--bg-muted); }
.row-links tbody th a::after { content: ""; position: absolute; inset: 0; }
.row-links tbody th a:focus-visible { outline: none; }
.row-links tbody th a:focus-visible::after { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: var(--r-sm); }
.cell-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cell-main strong { display: block; font-weight: 500; }
.cell-main span span { color: var(--text-faint); font-size: var(--fs-xs); font-weight: 400; }
.audit-table { min-width: 640px; }
.audit-table tbody th { font-weight: 400; color: var(--text-muted); white-space: nowrap; }

/* Option tiles: a checkbox card per choice */
.tiles { margin: 0; padding: 0; border: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.tile { margin: 0; display: grid; grid-template-columns: 16px 28px minmax(0, 1fr); align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-md); cursor: pointer; font-weight: 400; }
.tile:hover { background: var(--bg-subtle); }
.tile:has(input:checked) { border-color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.tile input { margin: 0; accent-color: var(--primary); }
.tile-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tile-text strong { font-size: var(--fs-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-text .status { font-size: var(--fs-xs); color: var(--text-muted); white-space: normal; }
.tile-text .hint { color: var(--text-faint); }
.tool-ico { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: -0.02em; }

/* Inline editor and menus: native disclosures holding a popover */
.inline-edit, .menu { position: relative; margin: 0; padding: 0; border: 0; }
.page-head .inline-edit { margin: 4px 0 0 -10px; }
.inline-edit > summary, .menu > summary, .all-fields > summary { list-style: none; }
.inline-edit > summary::-webkit-details-marker, .menu > summary::-webkit-details-marker, .all-fields > summary::-webkit-details-marker { display: none; }
.inline-edit[open] > summary, .menu[open] > summary { background: var(--bg-hover); color: var(--text); }
.inline-edit .popover { left: 0; top: calc(100% + 6px); width: min(320px, calc(100vw - 32px)); padding: 14px; }
.inline-edit .popover form { display: flex; flex-direction: column; gap: 6px; }
.inline-edit label { margin: 0; }
.inline-edit input { max-width: none; margin: 0; }
.inline-edit .actions { display: flex; justify-content: flex-end; margin-top: 6px; }
.menu .popover { right: 0; top: calc(100% + 6px); min-width: 260px; }
.popover-note { margin: 0; padding: 6px 8px 8px; color: var(--text-muted); font-size: var(--fs-xs); }

/* Filter row: GET form controls */
.filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.input-wrap { margin: 0; display: inline-flex; align-items: center; gap: 8px; height: var(--ctl-h-sm); width: 180px; padding: 0 10px; border: 1px solid var(--control); border-radius: var(--r-sm); background: var(--bg); color: var(--text-faint); font-weight: 400; }
.input-wrap:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
.input-wrap input { min-width: 0; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); outline: none; color: var(--text); font-size: var(--fs-xs); }
.seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-sm); background: var(--bg-muted); font-size: var(--fs-xs); }
.seg a { padding: 3px 10px; border-radius: var(--r-sm); color: var(--text-muted); text-decoration: none; white-space: nowrap; }
.seg a:hover { color: var(--text); }
.seg a.on { background: var(--bg); color: var(--text); font-weight: 500; box-shadow: 0 0 0 1px var(--border); }
.filter { position: relative; display: inline-flex; align-items: center; gap: 6px; height: var(--ctl-h-sm); padding: 0 10px; border: 1px dashed var(--control); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); text-decoration: none; white-space: nowrap; }
.filter:hover { background: var(--bg-hover); }
.filter.set { border-style: solid; color: var(--text); }
.filter.set > span { color: var(--text-muted); }
.filter strong { font-weight: 500; }
.filter svg { width: 12px; height: 12px; vertical-align: 0; }
.filter select { appearance: none; field-sizing: content; display: inline; width: auto; max-width: 180px; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); color: inherit; font: inherit; font-weight: 500; cursor: pointer; }
.filter:not(.set) select { font-weight: 400; }
.filter a { display: inline-flex; color: var(--text-muted); }
.filter:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
.range-fields { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); }
.range-fields label { margin: 0; font-weight: 500; font-size: var(--fs-xs); }
.range-fields input { width: 200px; height: var(--ctl-h-sm); margin: 0; font-family: var(--mono); font-size: var(--fs-xs); }

/* Docked side sheet: record detail beside its list */
.split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
.split.has-aside { grid-template-columns: minmax(0, 1fr) var(--aside-w); }
.split-main { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.sheet { min-width: 0; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-lg); }
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
.code { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.copyfield { display: flex; align-items: center; gap: 4px; }
.copyfield input { min-width: 0; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); }
.all-fields { margin: 0; padding: 0; border: 0; }
.all-fields[open] > summary { margin-bottom: 14px; }
.all-fields .kv { font-size: var(--fs-xs); }

/* Toast: tier-1 results announced after the page reloads */
.toast { position: fixed; z-index: 60; right: 20px; bottom: 20px; max-width: min(380px, calc(100vw - 40px)); margin: 0; padding: 12px 14px; border: 1px solid var(--ok-border); border-radius: var(--r-md); background: var(--ok-soft); color: var(--ok); box-shadow: var(--shadow-pop); font-size: var(--fs-sm); }
.toast:empty { display: none; }

/* Tier-3 confirmation: typing the exact name enables the red confirm button */
dialog.danger h2 { color: var(--err); }
[data-confirm-name-field] { margin: 0 0 12px; font-weight: 400; color: var(--text-muted); }
[data-confirm-name-field] strong { color: var(--text); font-weight: 600; }

/* Narrow screens: the sidebar moves behind a menu button and works without JavaScript */
@media (max-width: 760px) {
  .app { display: block; }
  .side { display: none; position: fixed; inset: 0; z-index: 50; height: auto; border-right: 0; }
  .side:target { display: flex; }
  .btn.side-close { display: inline-flex; margin-left: auto; }
  .btn.menu-open { display: inline-flex; margin-left: -6px; }
  .topbar { padding: 0 var(--gutter); }
  .page-head { flex-wrap: wrap; }
  .account-menu.down .who { display: none; }
  .crumbs span, .crumbs > a, .learn .label { display: none; }
  .list-row { flex-wrap: wrap; }
  .list-row .btn { margin-left: 36px; }
  .card.danger .list-row .btn { margin-left: 0; }
  .page-head .actions { margin-left: 0; }
  .page-head .menu .popover { left: 0; right: auto; }
  .tiles { grid-template-columns: minmax(0, 1fr); }
  .split.has-aside { grid-template-columns: minmax(0, 1fr); }
  .sheet.docked { position: static; max-height: none; order: -1; }
  .input-wrap { width: 100%; }
  .row-links.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .row-links.stack tbody tr { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .row-links.stack tbody tr:last-child { border-bottom: 0; }
  .row-links.stack tbody th, .row-links.stack tbody td { display: block; padding: 0; border: 0; }
  .row-links.stack tbody th { flex-basis: 100%; }
  .row-links.stack tbody td[data-label]::before { content: attr(data-label) " "; color: var(--text-faint); }
  .row-links.stack tbody td:not([data-label]):last-child.num { display: none; }
}
`
