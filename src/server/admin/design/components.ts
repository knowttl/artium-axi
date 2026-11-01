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
.audit-table { min-width: 760px; }
.audit-table td:nth-child(2) { min-width: 348px; }
.audit-table th:nth-child(n+4), .audit-table td:nth-child(n+4) { min-width: 100px; }

/* Layout helpers */
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) var(--aside-w); gap: 20px; align-items: start; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.mono { font-family: var(--mono); }

/* Badge and status: words from status.ts; the dot is decorative */
.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
.badge svg.i { width: 13px; height: 13px; vertical-align: 0; }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-border); }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-border); }
.badge.err { color: var(--err); background: var(--err-soft); border-color: var(--err-border); }
.badge.info { color: var(--info); background: var(--info-soft); border-color: var(--info-border); }
.dot { width: 7px; height: 7px; flex: none; display: inline-block; border-radius: var(--r-full); background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.dot.neutral { background: var(--control); }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--fs-sm); white-space: nowrap; }
.status svg.i { vertical-align: 0; }
.status.ok { color: var(--ok); }
.status.warn { color: var(--warn); }
.status.err { color: var(--err); }
.note:empty { display: none; }

/* Card parts */
.card-head .actions, .card-foot .actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.card-body { padding: 18px; }
.card-body > :last-child { margin-bottom: 0; }
.card-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); }
.card h3 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
.card .card-body p { margin: 0 0 10px; color: var(--text-muted); font-size: var(--fs-sm); }
form.card, .card-foot form, .card-head form { margin: 0; }
.card .list-row .grow a { font-weight: 500; text-decoration: none; }
.card .list-row .grow a:hover { text-decoration: underline; }

/* Table */
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.tbl th { padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; text-align: left; white-space: nowrap; }
.tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl tbody tr:last-child > * { border-bottom: 0; }
.tbl tbody tr:hover { background: var(--bg-subtle); }
.tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tbl td.muted, .tbl td.faint { white-space: nowrap; }
.card > .tbl:first-child th:first-child { border-top-left-radius: var(--r-lg); }
.card > .tbl:first-child th:last-child { border-top-right-radius: var(--r-lg); }
.cell-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cell-main a { display: block; color: var(--text); font-weight: 500; text-decoration: none; }
.cell-main a:hover { text-decoration: underline; }
.cell-main span:not(.tool-ico) { color: var(--text-faint); font-size: var(--fs-xs); }
.tool-ico { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: -0.02em; }
.tool-ico.lg { width: 44px; height: 44px; border-radius: 10px; font-size: 15px; }
.empty { padding: 18px; color: var(--text-muted); font-size: var(--fs-sm); }

/* Identity page header: icon, h1, meta line with badges, actions */
.page-head .grow { flex: 1; min-width: 0; }
.page-head .meta { margin-top: 6px; color: var(--text-muted); font-size: var(--fs-sm); }
.page-head .actions { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.page-head .actions form { margin: 0; }
.page-head.identity { align-items: center; }

/* Callout */
.callout { display: flex; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); font-size: var(--fs-sm); }
.callout > svg.i { margin-top: 2px; }
.callout .grow { flex: 1; min-width: 0; }
.callout b { display: block; margin-bottom: 2px; font-weight: 600; }
.callout p { margin: 0; color: var(--text-muted); }
.callout p + p { margin-top: 6px; }
.callout .actions { margin-left: auto; display: flex; flex: none; align-items: flex-start; gap: 8px; }
.callout details { margin: 8px 0 0; padding: 0; border: 0; }
.callout pre { margin: 8px 0 0; background: var(--bg); }
.callout.info { background: var(--info-soft); border-color: var(--info-border); }
.callout.info > svg.i { color: var(--info); }
.callout.warn { background: var(--warn-soft); border-color: var(--warn-border); }
.callout.warn > svg.i { color: var(--warn); }
.callout.err { background: var(--err-soft); border-color: var(--err-border); }
.callout.err > svg.i { color: var(--err); }
.callout.ok { background: var(--ok-soft); border-color: var(--ok-border); }
.callout.ok > svg.i { color: var(--ok); }

/* Tabs: links, one server-rendered view each */
.utabs { display: flex; gap: 20px; overflow-x: auto; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
.utabs a { display: inline-flex; align-items: center; gap: 6px; margin-bottom: -1px; padding: 10px 0; border-bottom: 2px solid var(--transparent); color: var(--text-muted); text-decoration: none; white-space: nowrap; }
.utabs a:hover { color: var(--text); }
.utabs a[aria-current="page"] { border-color: var(--text); color: var(--text); font-weight: 500; }
.utabs .n { color: var(--text-faint); font-size: 11px; font-weight: 400; }

/* Steps: state is in the text, the mark is decorative */
.steps { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; }
.step { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-right: 1px solid var(--border); background: var(--bg); font-size: var(--fs-sm); }
.step:last-child { border-right: 0; }
.step b { display: block; font-weight: 500; }
.step > div > span { color: var(--text-muted); font-size: var(--fs-xs); }
.step .mark { width: 20px; height: 20px; flex: none; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-full); color: var(--text-faint); font-size: 11px; }
.step .mark svg.i { width: 12px; height: 12px; vertical-align: 0; stroke-width: 2.5; }
.step.done .mark { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.step.fail .mark { background: var(--err); border-color: var(--err); color: var(--bg); }
.step.current { background: var(--bg-subtle); }

/* Segmented control and search: GET filter controls */
.seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-sm); background: var(--bg-muted); font-size: var(--fs-xs); }
.seg a, .seg label { margin: 0; padding: 3px 10px; border-radius: 5px; color: var(--text-muted); font-size: var(--fs-xs); font-weight: 400; text-decoration: none; cursor: pointer; white-space: nowrap; }
.seg [aria-current="page"], .seg label:has(input:checked) { background: var(--bg); color: var(--text); font-weight: 500; }
.seg label:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
.search { position: relative; display: flex; align-items: center; min-width: 0; }
.search svg.i { position: absolute; left: 10px; color: var(--text-faint); pointer-events: none; }
:where(.content) .search input { max-width: none; margin: 0; padding-left: 32px; }
.filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; }
.filters .search { flex: 1; min-width: 200px; }
.filters .search.narrow { flex: 0 1 240px; margin-left: auto; }

/* Fields: label, control, one-sentence hint */
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 20px; }
.form-grid > * { min-width: 0; }
.form-grid .full, .form-grid > :not([data-credential-field]) { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 6px; }
:where(.content) .field label { margin: 0; }
:where(.content) .field input:not([type=checkbox], [type=radio], [type=hidden], [type=file]), :where(.content) .field select, :where(.content) .field textarea { max-width: none; }
.field .hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.opt { color: var(--text-faint); font-weight: 400; }
.secret { display: flex; align-items: center; gap: 10px; min-height: var(--ctl-h); margin-top: 6px; padding: 0 6px 0 10px; border: 1px dashed var(--border-strong); border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); font-weight: 400; }
.secret .btn { margin-left: auto; }

/* Credential editor (credentialFields): a two-column field grid */
[data-credential-editor] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 20px; }
[data-credential-editor] > * { grid-column: 1 / -1; min-width: 0; }
[data-credential-editor] > [data-credential-field]:not(:has(textarea)) { grid-column: auto; }
[data-credential-editor] > p { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
:where(.content) [data-credential-editor] label { margin: 0; }
:where(.content) [data-credential-editor] :where(input:not([type=checkbox], [type=radio], [type=hidden]), select, textarea) { max-width: none; }
:where(.content) [data-credential-field] > p { margin: 6px 0 0; color: var(--text-muted); font-size: var(--fs-xs); }
:where(.content) [data-credential-field] > p[data-stored-secret] { display: flex; align-items: center; min-height: var(--ctl-h-sm); padding: 4px 10px; border: 1px dashed var(--border-strong); border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-muted); }
:where(.content) [data-credential-editor] > details { margin: 0; }
[data-credential-editor] [data-certificate] { display: grid; gap: 12px; }

/* Switch: a native checkbox (or a decorative span inside a labelled button) */
.switch { position: relative; width: 32px; height: 18px; flex: none; display: inline-block; margin: 0; border-radius: var(--r-full); background: var(--control); appearance: none; cursor: pointer; vertical-align: middle; }
.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: var(--r-full); background: var(--bg); transition: left 120ms; }
.switch.on, input.switch:checked { background: var(--primary); }
.switch.on::before, input.switch:checked::before { left: 16px; background: var(--primary-fg); }
input.switch:disabled { opacity: 0.5; cursor: not-allowed; }
:where(.content) input.switch[type=checkbox] { width: 32px; height: 18px; margin: 2px 0 0; }
.switch-row { display: flex; align-items: flex-start; gap: 14px; margin: 0; font-weight: 400; }
:where(.content) label.switch-row { margin: 0; }
.switch-row b { display: block; font-weight: 500; }
.switch-row span { color: var(--text-muted); font-size: var(--fs-sm); }
.switch-row + .switch-row { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
:where(.content) .toggle { height: auto; padding: 4px 6px; border: 0; background: var(--transparent); gap: 8px; font-size: var(--fs-sm); }

/* Operation catalogue */
.ops { display: flex; flex-direction: column; gap: 8px; }
:where(.content) .ops-group { margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--r-md); }
.ops-group > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 10px 12px; list-style: none; font-size: var(--fs-sm); font-weight: 400; }
.ops-group > summary::-webkit-details-marker { display: none; }
.ops-group > summary > svg.i { color: var(--text-faint); transition: transform 120ms; }
.ops-group[open] > summary > svg.i { transform: rotate(90deg); }
.ops-group > summary b { font-weight: 500; }
.ops-group > summary .muted { font-size: var(--fs-xs); }
.ops-group > summary .end { margin-left: auto; display: flex; gap: 6px; }
.ops-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 20px; padding: 8px 12px 12px 36px; border-top: 1px solid var(--border); }
:where(.content) label.op { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; margin: 0; font-size: var(--fs-sm); font-weight: 400; }
:where(.content) label.op input { margin: 0; }
.op code { color: var(--text-faint); font-size: 11px; overflow-wrap: anywhere; }
.op .badge { height: 18px; padding: 0 6px; font-size: 10.5px; }
.ops-empty { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
.card .note[data-valid="true"] { color: var(--ok); }
.card .note[data-valid="false"] { color: var(--err); }

/* Key-value list and large code */
.kv { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: var(--fs-sm); }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.bigcode { padding: 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); font-family: var(--mono); font-size: 28px; font-weight: 600; letter-spacing: 0.18em; text-align: center; }
.bigcode:empty { display: none; }

@media (max-width: 1080px) {
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

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
  .crumbs span, .learn .label { display: none; }
  .list-row { flex-wrap: wrap; }
  .list-row .btn { margin-left: 36px; }
  .steps { grid-template-columns: minmax(0, 1fr); }
  .step { border-right: 0; border-bottom: 1px solid var(--border); }
  .step:last-child { border-bottom: 0; }
  .form-grid, .ops-body, [data-credential-editor] { grid-template-columns: minmax(0, 1fr); }
  .ops-body { padding-left: 12px; }
  .page-head .actions { margin-left: 0; width: 100%; }
  .filters .search.narrow { flex: 1 1 100%; margin-left: 0; }
  .callout { flex-wrap: wrap; }
  .kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .kv dd { margin-bottom: 8px; }
  /* Tables become stacked rows */
  .tbl.stack-sm thead { display: none; }
  .tbl.stack-sm tr { display: block; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .tbl.stack-sm tbody tr:last-child { border-bottom: 0; }
  .tbl.stack-sm td { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border: 0; text-align: left; }
  .tbl.stack-sm td[data-label]::before { content: attr(data-label); color: var(--text-faint); font-size: var(--fs-xs); }
  .tbl.stack-sm td:first-child { padding-bottom: 6px; }
  .tbl.stack-sm td > * { min-width: 0; overflow-wrap: anywhere; }
  .tbl.stack-sm .num { text-align: right; }
}
`
