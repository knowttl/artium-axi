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
.link { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
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

/* Callout: a consequence or result placed where the decision happens */
.callout { display: flex; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); font-size: var(--fs-sm); }
.callout > svg { margin-top: 2px; }
.callout > div { min-width: 0; }
.callout strong { display: block; margin-bottom: 2px; font-weight: 600; }
.callout p, .callout ul { margin: 0; color: var(--text-muted); }
.callout ul { padding-left: 18px; }
.callout.info { background: var(--info-soft); border-color: var(--info-border); }
.callout.info > svg { color: var(--info); }
.callout.ok { background: var(--ok-soft); border-color: var(--ok-border); }
.callout.ok > svg { color: var(--ok); }
.callout.warn { background: var(--warn-soft); border-color: var(--warn-border); }
.callout.warn > svg { color: var(--warn); }
.callout.err { background: var(--err-soft); border-color: var(--err-border); }
.callout.err > svg { color: var(--err); }

/* Toasts: action results in a fixed region */
.toasts { position: fixed; right: 20px; bottom: 20px; z-index: 60; width: min(360px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.toast { margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); box-shadow: var(--shadow-pop); color: var(--text); font-size: var(--fs-sm); pointer-events: auto; overflow-wrap: anywhere; }
.toast:empty { display: none; }
.toast.ok::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: var(--r-full); background: var(--ok); vertical-align: 1px; }
.toast.err { background: var(--err-soft); border-color: var(--err-border); color: var(--err); }
.toast .btn { margin-top: 8px; }
.toast:focus { outline: none; }

/* Layout helpers for page content */
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.provider-sidebar { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.card.warn { border-color: var(--warn-border); }
.summary { display: flex; flex-direction: column; gap: 6px; }
.summary .label { color: var(--text-faint); font-size: var(--fs-xs); }
.card.warn .summary .label { color: var(--warn); }
.summary strong { font-weight: 600; }
.summary p { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
.summary .btn { align-self: flex-start; }
.hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.list-row .badges { flex: none; }
.list-row .grow p.sentence { margin: 0; color: var(--text); font-size: var(--fs-sm); font-weight: 500; }
.list-row .sentence svg { color: var(--text-faint); }
.list-row .grow strong a { text-decoration: none; }
.list-row .grow strong a:hover { text-decoration: underline; }

/* Tabs: links, each tab is its own server-rendered view */
.utabs { display: flex; gap: 20px; overflow-x: auto; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
.utabs a { display: inline-flex; align-items: center; gap: 6px; margin-bottom: -1px; padding: 10px 0; border-bottom: 2px solid var(--transparent); color: var(--text-muted); text-decoration: none; white-space: nowrap; }
.utabs a:hover { color: var(--text); }
.utabs a[aria-current="page"] { color: var(--text); border-color: var(--text); font-weight: 500; }
.utabs .n { color: var(--text-faint); font-size: 11px; }

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

/* Segmented control; the host picker works without JavaScript */
.seg input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.seg label { margin: 0; padding: 3px 10px; border-radius: 5px; color: var(--text-muted); font-size: var(--fs-xs); font-weight: 400; cursor: pointer; }
.seg input:checked + label { background: var(--bg); color: var(--text); box-shadow: var(--shadow-sm); font-weight: 500; }
.seg input:focus-visible + label { outline: 2px solid var(--focus); outline-offset: 1px; }
.host-command { display: none; }
.hosts:has(#host-claude:checked) .host-command.claude, .hosts:has(#host-codex:checked) .host-command.codex,
.hosts:has(#host-opencode:checked) .host-command.opencode, .hosts:has(#host-pi:checked) .host-command.pi { display: block; }

/* Data table */
.tbl .muted { color: var(--text-muted); white-space: nowrap; }
.card > .tbl, .card > .table-scroll { margin: 0; border: 0; border-radius: 0 0 var(--r-lg) var(--r-lg); }
.card-head + .table-scroll { border-radius: 0 0 var(--r-lg) var(--r-lg); }
:where(.content) .tbl form, :where(.content) .actions form { margin: 0; display: inline-flex; }
.tbl .num > * + * { margin-left: 8px; }

/* Field: label, control, hint */
.field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px; }
:where(.content, .auth-card, dialog) .field label { margin: 0; }
:where(.content, .auth-card, dialog) .field :where(input, select, textarea) { margin-top: 0; }
.auth-card .field { margin: 0; }
.auth-card .field input { max-width: none; }

/* Tool grid: granted tools with availability */
.tool-grid { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 16px; }
.tool-grid li { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tool-grid strong { display: block; font-size: var(--fs-sm); font-weight: 500; }
.tool-grid .status { font-size: var(--fs-xs); color: var(--text-muted); }

/* Disclosure card: a collapsible section */
:where(.content) .disclosure { margin: 0; padding: 0; border-top: 1px solid var(--border); }
.disclosure > summary { list-style: none; cursor: pointer; border-radius: var(--r-lg); }
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure > summary:hover { background: var(--bg-subtle); }
.disclosure > summary > svg:last-child { color: var(--text-faint); }
.disclosure[open] > summary { border-bottom: 1px solid var(--border); border-radius: var(--r-lg) var(--r-lg) 0 0; }
.disclosure[open] > summary > svg:last-child { transform: rotate(180deg); }
.copyvalue { display: inline-flex; flex-wrap: wrap; align-items: flex-start; gap: 4px; }
.copyvalue [data-copy-text] { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }
.copyvalue .btn { margin: -4px 0; }
[data-copy-scope] > .copy-status { margin: 4px 0 0; }

/* View dialogs: server-rendered forms in a dialog */
.modal-head { display: flex; align-items: flex-start; gap: 8px; }
.modal-head h2 { flex: 1; }
.modal-head .btn { margin: -4px -8px 0 0; }
.modal-body form > button:last-child { display: flex; margin: 16px 0 10px auto; }
.modal-body form { margin: 12px 0 0; }

.popover .danger { color: var(--err); }
.popover .danger:hover { background: var(--err-soft); }

/* Option card: a native radio with a title and description */
.options { display: flex; flex-direction: column; gap: 8px; }
:where(.content, dialog) .option { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 12px; border: 1px solid var(--border-strong); border-radius: var(--r-md); font-weight: 400; cursor: pointer; }
.option:has(input:checked) { border-color: var(--text); background: var(--bg-subtle); }
.option input { margin-top: 3px; }
.option strong { display: block; font-weight: 500; }
.option span { color: var(--text-muted); font-size: var(--fs-sm); }

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
.stack:not(table) { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) var(--aside-w); gap: 20px; align-items: start; }
.page-head .grow { flex: 1; min-width: 0; }
.page-head > .actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.page-head.identity { align-items: center; }
.page-head .meta { margin-top: 6px; }
.page-head .meta code { color: var(--text-muted); font-size: var(--fs-sm); }
.grow { flex: 1; min-width: 0; }

/* More buttons */
.btn-ghost.danger { color: var(--err); }
.btn-ghost.danger:hover { background: var(--err-soft); color: var(--err); }

/* Additions to the shared badge, dot and chip below */
.badge.solid { color: var(--bg); background: var(--text); border-color: var(--text); }
.dot.info { background: var(--info); }
a.chip:hover { background: var(--bg-active); }
.none { color: var(--text-faint); font-size: var(--fs-sm); }
.avatar.lg { width: 48px; height: 48px; font-size: var(--fs-md); }

/* Card parts */
.card-head .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.card-body.stack { gap: 14px; }
.card-body .list-row { padding: 10px 0; }
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
.tbl tbody tr.link { position: relative; }
.tbl tbody tr.link:hover { background: var(--bg-subtle); }
.tbl .row-link { color: var(--text); text-decoration: none; }
.tbl .row-link::after { content: ""; position: absolute; inset: 0; }
.tbl tr.link a:not(.row-link) { position: relative; z-index: 1; }
.tbl .row-link:focus-visible { outline: 0; }
.tbl tr.link:has(.row-link:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
.tbl tr.dim { opacity: 0.6; }
.tbl .muted { color: var(--text-muted); white-space: nowrap; }
.tbl .faint { color: var(--text-faint); white-space: nowrap; }
.tbl td.actions-cell { text-align: right; white-space: nowrap; }
.tbl td.actions-cell > * { display: inline-flex; vertical-align: middle; }
.tbl code { font-size: var(--fs-xs); }
.cell-main span:not(.avatar, .tool-ico) { display: block; color: var(--text-faint); font-size: var(--fs-xs); }
.cell-main > svg { color: var(--text-muted); }

/* The filter row itself is shared below; the People count note sits at its end */
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
.copy-group .copyfield { gap: 6px; }
.copyfield .input { font-family: var(--mono); font-size: var(--fs-xs); background: var(--bg-subtle); }
.copy-status { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
.copy-status:empty { display: none; }

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
dialog.sheet .sheet-head { padding: 18px 20px; }
dialog.sheet .sheet-body { flex: 1; overflow: auto; padding: 20px; }
.sheet-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); background: var(--bg-subtle); }
.modal-body .field { margin-top: 4px; }

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
.modal-body h2 { display: flex; align-items: center; gap: 10px; }
.modal-body p { margin: 0 0 12px; color: var(--text-muted); font-size: var(--fs-sm); }
.modal-body .field { margin-bottom: 12px; }
.ico-circle { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: var(--r-full); background: var(--bg-muted); color: var(--text-muted); }
.ico-circle.ok { background: var(--ok-soft); color: var(--ok); }
.ico-circle.warn { background: var(--warn-soft); color: var(--warn); }
.ico-circle.err { background: var(--err-soft); color: var(--err); }
/* A dialog rendered open by the server is the no-JavaScript fallback; confirm.js makes it modal. */
dialog.modal[open]:not(:modal) { position: fixed; inset: 0; z-index: 70; margin: auto; height: fit-content; }
.modal-foot, .dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.modal-foot { margin: 0; padding: 14px 22px 18px; }
.modal-error { margin: 0 22px; color: var(--err); font-size: var(--fs-sm); }
.modal-body .modal-error { margin: 0 0 12px; color: var(--err); }
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
.auth-card .btn { width: 100%; }
.auth-card .copyvalue .btn { width: var(--ctl-h-sm); flex: none; }
.auth-card code { font-size: 0.88em; white-space: nowrap; }
.auth-card .kv { grid-template-columns: 110px minmax(0, 1fr); }
.auth-head { display: flex; align-items: center; gap: 10px; }
.auth-head h1 { margin: 0; font-size: var(--fs-md); font-weight: 600; letter-spacing: -0.01em; }
.auth-actions { display: flex; gap: 8px; }
.auth-actions > * { flex: 1; }
.auth-actions form { flex: 1; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--text-faint); font-size: var(--fs-xs); }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
.bigcode { padding: 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); font-family: var(--mono); font-size: 28px; font-weight: 600; letter-spacing: 0.18em; text-align: center; }
.auth-foot { margin: 14px 0 0; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; }
.auth-foot .link { min-height: var(--ctl-h-sm); }
.auth-foot .check { justify-content: center; align-items: center; min-height: var(--ctl-h-sm); }
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
.table-scroll { max-width: 100%; margin: 12px 0; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); }
:where(.content, dialog) :where(table) { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); text-align: left; }
:where(.content, dialog) :where(caption) { padding: 10px 14px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--border); }
:where(.content, dialog) :where(th, td) { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: break-word; }
:where(.content, dialog) :where(thead th) { background: var(--bg-subtle); color: var(--text-faint); font-size: var(--fs-xs); font-weight: 500; white-space: nowrap; }
:where(.content, dialog) :where(tbody th) { font-weight: 500; }
:where(.content, dialog) :where(tbody tr:last-child) > * { border-bottom: 0; }
.session-table time, .session-table button { white-space: nowrap; }

/* Page header actions and record metadata */
.page-head .actions, .card-head .actions, .card-foot .actions { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.page-head .actions { flex: none; }
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
.badge.solid { color: var(--bg); background: var(--text); border-color: var(--text); }
.dot { width: 7px; height: 7px; flex: none; display: inline-block; border-radius: var(--r-full); background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.dot.info { background: var(--info); }
.dot.off { background: var(--control); }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); white-space: nowrap; }
.badges { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: var(--r-sm); background: var(--bg-muted); color: var(--text); font-size: var(--fs-xs); white-space: nowrap; }

/* Card parts */
.card-body { padding: 18px; }
.card-body > :first-child { margin-top: 0; }
.card-body > :last-child { margin-bottom: 0; }
.card-body h3 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
.card-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--bg-subtle); color: var(--text-muted); font-size: var(--fs-sm); }
.card-foot p { margin: 0; }
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
.tbl th, .tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; text-align: left; }
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
.cell-main > svg { color: var(--text-muted); }
.cell-main strong { display: block; font-weight: 500; }
.cell-main a { font-weight: 500; }
.cell-main .sub { display: block; color: var(--text-faint); font-size: var(--fs-xs); font-weight: 400; overflow-wrap: anywhere; }
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
.tool-ico.lg { width: 44px; height: 44px; border-radius: 10px; font-size: 15px; }

/* Inline editor and menus: native disclosures holding a popover */
.inline-edit, .menu { position: relative; margin: 0; padding: 0; border: 0; }
.menu { flex: none; }
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
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--r-sm); background: var(--bg-muted); font-size: var(--fs-xs); }
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
.copyfield { display: flex; align-items: center; gap: 4px; }
.copyfield input:not(.input) { min-width: 0; max-width: none; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); }
.all-fields { margin: 0; padding: 0; border: 0; }
.all-fields[open] > summary { margin-bottom: 14px; }
.all-fields .kv { font-size: var(--fs-xs); }

/* Tier-3 confirmation: typing the exact name enables the red confirm button */
[data-confirm-name-field] { margin: 0 0 12px; font-weight: 400; color: var(--text-muted); }
[data-confirm-name-field] strong { color: var(--text); font-weight: 600; }

@media (max-width: 1080px) {
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

/* Badge and status: words from status.ts; the dot is decorative */
.badge svg.i { width: 13px; height: 13px; vertical-align: 0; }
.status svg.i { vertical-align: 0; }
.status.warn { color: var(--warn); }
.status.neutral { color: var(--text-muted); }
.note:empty { display: none; }

/* Card parts */
.card-head .actions, .card-foot .actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.card h3 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
.card .card-body p { margin: 0 0 10px; color: var(--text-muted); font-size: var(--fs-sm); }
form.card, .card-foot form, .card-head form { margin: 0; }
.card .list-row .grow a { font-weight: 500; text-decoration: none; }
.card .list-row .grow a:hover { text-decoration: underline; }

/* Table */
.tbl.stack-sm tbody tr:hover { background: var(--bg-subtle); }
.tbl td.muted, .tbl td.faint { white-space: nowrap; }
.cell-main a { display: block; color: var(--text); font-weight: 500; text-decoration: none; }
.cell-main a:hover { text-decoration: underline; }
.cell-main span:not(.tool-ico) { color: var(--text-faint); font-size: var(--fs-xs); }
.tool-ico.lg { width: 44px; height: 44px; border-radius: 10px; font-size: 15px; }
.empty { padding: 18px; color: var(--text-muted); font-size: var(--fs-sm); }

/* Identity page header: icon, h1, meta line with badges, actions */
.page-head .meta { margin-top: 6px; color: var(--text-muted); font-size: var(--fs-sm); }

/* Callout additions */
.callout .grow { flex: 1; min-width: 0; }
.callout p + p { margin-top: 6px; }
.callout details { margin: 8px 0 0; padding: 0; border: 0; }
.callout pre { margin: 8px 0 0; background: var(--bg); }

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
.seg label { margin: 0; padding: 3px 10px; border-radius: var(--r-sm); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 400; cursor: pointer; white-space: nowrap; }
.seg [aria-current="page"], .seg label:has(input:checked) { background: var(--bg); color: var(--text); font-weight: 500; box-shadow: 0 0 0 1px var(--border); }
.seg label:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
.search { position: relative; display: flex; align-items: center; min-width: 0; }
.search svg.i { position: absolute; left: 10px; color: var(--text-faint); pointer-events: none; }
:where(.content) .search input { max-width: none; margin: 0; padding-left: 32px; }
.filters .search { flex: 1; min-width: 200px; }
.filters .search.narrow { flex: 0 1 240px; margin-left: auto; }

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
  .tbl.stacked td[data-label]::before { content: attr(data-label) ": "; color: var(--text-faint); }
  .filters .input-wrap { width: 100%; }
  .page-head > .actions { flex-basis: 100%; margin-left: 0; }
  .callout { flex-wrap: wrap; }
  .callout .grow { flex-basis: calc(100% - 28px); }
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
  .crumbs span, .crumbs > a, .learn .label { display: none; }
  .list-row { flex-wrap: wrap; }
  .list-row .grow { min-width: 60%; }
  .list-row .btn { margin-left: 36px; }
  .grid2, .grid3, .tool-grid { grid-template-columns: minmax(0, 1fr); }
  .toasts { right: 16px; bottom: 16px; }
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
  .steps { grid-template-columns: minmax(0, 1fr); }
  .step { border-right: 0; border-bottom: 1px solid var(--border); }
  .step:last-child { border-bottom: 0; }
  .ops-body, [data-credential-editor] { grid-template-columns: minmax(0, 1fr); }
  .ops-body { padding-left: 12px; }
  .filters .search.narrow { flex: 1 1 100%; margin-left: 0; }
  .tbl.stack-sm, .tbl.stack-sm tbody { display: block; }
  .tbl.stack-sm thead { display: none; }
  .tbl.stack-sm tr { display: block; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .tbl.stack-sm tbody tr:last-child { border-bottom: 0; }
  .tbl.stack-sm td { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border: 0; text-align: left; }
  .tbl.stack-sm td[data-label]::before { content: attr(data-label); color: var(--text-faint); font-size: var(--fs-xs); }
  .tbl.stack-sm td:first-child { padding-bottom: 6px; }
  .tbl.stack-sm td > * { min-width: 0; overflow-wrap: anywhere; }
  .tbl.stack-sm .faint, .tbl.stack-sm .muted { white-space: normal; }
  .tbl.stack-sm .num { text-align: right; }
}
`
