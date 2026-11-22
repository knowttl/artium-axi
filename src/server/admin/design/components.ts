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

/* Layout helpers for page content */
.list-row .grow strong a { text-decoration: none; }
.list-row .grow strong a:hover { text-decoration: underline; }

/* Field: label, control, hint */
:where(.content, .auth-card, dialog) .field label { margin: 0; }

/* Tool grid: granted tools with availability */
.tool-grid .status { font-size: var(--fs-xs); color: var(--text-muted); }

/* Card and rows */
.list-row:last-child { border-bottom: 0; }

/* More buttons */
.btn-ghost.danger { color: var(--err); }
.btn-ghost.danger:hover { background: var(--err-soft); color: var(--err); }

/* Card parts */
.card-body .list-row { padding: 10px 0; }
.card > form, .card-foot form, .list-row form, .tbl form, .page-head form { margin: 0; }

.astryx-button.revoke { color: var(--err); }
.astryx-button.revoke:hover { background: var(--err-soft); }

/* The filter row itself is shared below; the People count note sits at its end */
.filters .count-note { margin-left: auto; color: var(--text-faint); font-size: var(--fs-xs); }

/* Fields */
.field > label, .field-label { margin: 0; font-size: var(--fs-sm); font-weight: 500; }
.field .hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }

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

/* Card parts */
.card-foot p { margin: 0; }
.card form { margin: 0; }
.list-row h2 { margin: 0; font-size: var(--fs-sm); font-weight: 500; }

/* Inline editor and menus: native disclosures holding a popover */
.inline-edit, .menu { position: relative; margin: 0; padding: 0; border: 0; }
.menu { flex: none; }
.inline-edit > summary, .menu > summary { list-style: none; }
.inline-edit > summary::-webkit-details-marker, .menu > summary::-webkit-details-marker { display: none; }
.inline-edit[open] > summary, .menu[open] > summary { background: var(--bg-hover); color: var(--text); }
.menu .popover { right: 0; top: calc(100% + 6px); min-width: 260px; }
.theme-row { display: flex; justify-content: center; padding: 0 8px 4px; }
.auth-wrap > .theme-row { margin-top: 14px; }
.popover-note { margin: 0; padding: 6px 8px 8px; color: var(--text-muted); font-size: var(--fs-xs); }

/* Docked side sheet: record detail beside its list */
.sheet-head .btn { margin-left: auto; }
.copyfield input:not(.input) { min-width: 0; max-width: none; height: auto; margin: 0; padding: 0; border: 0; background: var(--transparent); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); }
.all-fields .kv { font-size: var(--fs-xs); }

/* Badge and status: words from status.ts; the dot is decorative */
.status svg.i { vertical-align: 0; }
.status.warn { color: var(--warn); }
.status.neutral { color: var(--text-muted); }

/* Card parts */
form.card, .card-foot form, .card-head form { margin: 0; }

/* Narrow screens: the sidebar moves behind a menu button and works without JavaScript */
@media (max-width: 760px) {
  dialog.sheet { width: 100%; border-left: 0; }
  .list-row .btn { margin-left: 36px; }
}
`
