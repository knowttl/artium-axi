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

/* Layout */
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) var(--aside-w); gap: 20px; align-items: start; }
.page-head .grow { flex: 1; min-width: 0; }
.page-head > .actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.page-head.identity { align-items: center; }
.page-head .meta { margin-top: 6px; }
.page-head .meta code { color: var(--text-muted); font-size: var(--fs-sm); }
.grow { flex: 1; min-width: 0; }

/* More buttons */
.btn-danger { background: var(--danger-solid); color: var(--danger-fg); }
.btn-danger-outline { background: var(--bg); color: var(--err); border-color: var(--err-border); }
.btn-danger-outline:hover { background: var(--err-soft); }
.btn-ghost.danger { color: var(--err); }
.btn-ghost.danger:hover { background: var(--err-soft); color: var(--err); }
a.btn[aria-disabled="true"] { opacity: 0.5; pointer-events: none; }

/* Badge, status dot and chip: words from status.ts */
.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-border); }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-border); }
.badge.err { color: var(--err); background: var(--err-soft); border-color: var(--err-border); }
.badge.info { color: var(--info); background: var(--info-soft); border-color: var(--info-border); }
.badge.solid { color: var(--bg); background: var(--text); border-color: var(--text); }
.dot { width: 7px; height: 7px; flex: none; display: inline-block; border-radius: var(--r-full); background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.dot.info { background: var(--info); }
.dot.off { background: var(--control); }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); white-space: nowrap; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: var(--r-sm); background: var(--bg-muted); color: var(--text); font-size: var(--fs-xs); white-space: nowrap; text-decoration: none; }
a.chip:hover { background: var(--bg-active); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.none { color: var(--text-faint); font-size: var(--fs-sm); }
.avatar.lg { width: 48px; height: 48px; font-size: var(--fs-md); }
.tool-ico { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: -0.02em; }

/* Card parts */
.card-head .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.card-body { padding: 18px; }
.card-body.stack { gap: 14px; }
.card-body .list-row { padding: 10px 0; }
.card-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); }
.card-foot .actions { margin-left: auto; display: flex; gap: 8px; }
.card.danger { border-color: var(--err-border); }
.card.danger .card-head { border-color: var(--err-border); }
.card.danger .card-head h2 { color: var(--err); }
.card > form, .card-foot form, .list-row form, .tbl form, .page-head form, .popover form { margin: 0; }
.card > form { display: contents; }
.card-meta { margin: 0 4px; color: var(--text-faint); font-size: var(--fs-xs); }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.stat { display: flex; flex-direction: column; gap: 2px; padding: 16px 18px; }
.stat + .stat { border-left: 1px solid var(--border); }
.stat .label { color: var(--text-muted); font-size: var(--fs-sm); }
.stat .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat .value small { color: var(--text-faint); font-size: var(--fs-md); font-weight: 400; }
.stat .note { color: var(--text-faint); font-size: var(--fs-xs); }
.stat .note.ok { color: var(--ok); }
.stat .note.err { color: var(--err); }
.stat .note.warn { color: var(--warn); }

/* Table */
.table-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.tbl th { padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; text-align: left; white-space: nowrap; }
.tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.tbl tbody tr.link { position: relative; }
.tbl tbody tr.link:hover { background: var(--bg-subtle); }
.tbl .row-link { color: var(--text); text-decoration: none; }
.tbl .row-link::after { content: ""; position: absolute; inset: 0; }
.tbl .row-link:focus-visible { outline: 0; }
.tbl tr.link:has(.row-link:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
.tbl tr.dim > td { opacity: 0.6; }
.tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tbl .muted { color: var(--text-muted); white-space: nowrap; }
.tbl .faint { color: var(--text-faint); white-space: nowrap; }
.tbl td.actions-cell { text-align: right; white-space: nowrap; }
.tbl td.actions-cell > * { display: inline-flex; vertical-align: middle; }
.tbl code { font-size: var(--fs-xs); }
.cell-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cell-main strong { display: block; font-weight: 500; }
.cell-main span:not(.avatar, .tool-ico) { display: block; color: var(--text-faint); font-size: var(--fs-xs); }
.cell-main > svg { color: var(--text-muted); }

/* Filters: one GET form row */
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; }
.input-wrap { display: flex; align-items: center; gap: 8px; width: 280px; max-width: 100%; height: var(--ctl-h); padding: 0 10px; border: 1px solid var(--control); border-radius: var(--r-sm); background: var(--bg); color: var(--text-faint); }
.input-wrap:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
.input-wrap input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; background: var(--transparent); color: var(--text); font: inherit; font-size: var(--fs-sm); }
.input-wrap input:focus { outline: none; }
.filter { position: relative; display: inline-flex; align-items: center; gap: 4px; height: var(--ctl-h-sm); margin: 0; padding: 0 4px 0 10px; border: 1px dashed var(--border-strong); border-radius: var(--r-full); background: var(--bg); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 400; }
.filter.set { border-style: solid; color: var(--text); }
.filter > span { font-weight: 500; white-space: nowrap; }
.filter select { max-width: 200px; height: 100%; margin: 0; padding: 0 4px; border: 0; border-radius: var(--r-full); background: var(--transparent); color: inherit; font: inherit; cursor: pointer; }
.filter:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
.filter select:focus { outline: none; }
.filters .count-note { margin-left: auto; color: var(--text-faint); font-size: var(--fs-xs); }

/* Fields */
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label, .field-label { margin: 0; font-size: var(--fs-sm); font-weight: 500; }
.field .hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.input, .select { display: block; width: 100%; max-width: none; height: var(--ctl-h); margin: 0; padding: 0 10px; border: 1px solid var(--control); border-radius: var(--r-sm); background: var(--bg); color: var(--text); font: inherit; font-size: var(--fs-sm); }
.input.mono { font-family: var(--mono); }
.input.narrow { width: 96px; }
.input[aria-invalid="true"] { border-color: var(--err); }
.input:disabled { background: var(--bg-muted); color: var(--text-faint); cursor: not-allowed; }
.check { margin: 0; font-weight: 400; }
.check strong { display: block; font-weight: 500; }
.check > span > span { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
.check input { flex: none; }
.options { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; border: 0; }
.options legend { margin-bottom: 10px; padding: 0; font-size: var(--fs-sm); font-weight: 500; }
.copyfield, .input-row { display: flex; gap: 6px; }
.copyfield .input { font-family: var(--mono); font-size: var(--fs-xs); background: var(--bg-subtle); }
.copy-status { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.copy-status:empty { display: none; }

/* Key-value list */
.kv { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: var(--fs-sm); }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }

/* Callout */
.callout { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); font-size: var(--fs-sm); }
.callout > svg { margin-top: 2px; }
.callout strong { display: block; margin-bottom: 2px; font-weight: 600; }
.callout p { margin: 0; color: var(--text-muted); }
.callout .actions { margin-left: auto; display: flex; flex: none; gap: 8px; }
.callout.info { background: var(--info-soft); border-color: var(--info-border); }
.callout.info > svg { color: var(--info); }
.callout.ok { background: var(--ok-soft); border-color: var(--ok-border); }
.callout.ok > svg { color: var(--ok); }
.callout.warn { background: var(--warn-soft); border-color: var(--warn-border); }
.callout.warn > svg { color: var(--warn); }
.callout.err { background: var(--err-soft); border-color: var(--err-border); }
.callout.err > svg { color: var(--err); }

/* Vertical steps and meter */
.meter { display: block; width: 100%; height: 6px; margin: 0 0 18px; border: 0; border-radius: var(--r-full); background: var(--bg-muted); overflow: hidden; appearance: none; }
.meter::-webkit-progress-bar { background: var(--bg-muted); }
.meter::-webkit-progress-value { background: var(--ok); border-radius: var(--r-full); }
.meter::-moz-progress-bar { background: var(--ok); border-radius: var(--r-full); }
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
.sheet-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.sheet-head h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.sheet-head p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.sheet-body { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 18px; padding: 20px; }
.sheet-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); background: var(--bg-subtle); }
.modal-body h2 { display: flex; align-items: center; gap: 10px; }
.modal-body .field { margin-top: 4px; }
.ico-circle { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: var(--r-full); background: var(--bg-muted); }
.ico-circle.ok { background: var(--ok-soft); color: var(--ok); }
.ico-circle.err { background: var(--err-soft); color: var(--err); }

/* Overflow menu: a native disclosure like the account menu */
.more-menu { position: relative; margin: 0; padding: 0; border: 0; }
.more-menu summary { list-style: none; }
.more-menu summary::-webkit-details-marker { display: none; }
.more-menu[open] > summary { background: var(--bg-hover); }
.more-menu .popover { right: 0; top: calc(100% + 6px); }

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
.modal-foot { margin: 0; padding: 14px 22px 18px; }
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

@media (max-width: 1080px) {
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

/* Narrow screens: the sidebar moves behind a menu button and works without JavaScript */
@media (max-width: 760px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n+3) { border-top: 1px solid var(--border); }
  .tbl.stacked thead { display: none; }
  .tbl.stacked tr { display: block; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .tbl.stacked tbody tr:last-child { border-bottom: 0; }
  .tbl.stacked td { display: block; padding: 3px 14px; border: 0; }
  .tbl.stacked td.num, .tbl.stacked td.actions-cell { text-align: left; }
  .filters .input-wrap { width: 100%; }
  .page-head > .actions { margin-left: 0; }
  .callout { flex-wrap: wrap; }
  .callout .actions { margin-left: 28px; }
  dialog.sheet { width: 100%; border-left: 0; }
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
}
`
