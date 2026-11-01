// The only place a colour, size, radius, shadow or font value may appear. See docs/design-system.md.
export const tokens = `
:root {
  color-scheme: light;
  --transparent: transparent;
  --bg: #ffffff;
  --bg-subtle: #fafafa;
  --bg-muted: #f4f4f5;
  --bg-hover: #f4f4f5;
  --bg-active: #e4e4e7;
  --border: #e4e4e7;
  --border-strong: #d4d4d8;
  --control: #8e8e97;
  --text: #09090b;
  --text-muted: #52525b;
  --text-faint: #6b6b74;
  --primary: #18181b;
  --primary-hover: #27272a;
  --primary-fg: #fafafa;
  --danger-solid: #b91c1c;
  --focus: #2563eb;
  --ok: #15803d;   --ok-soft: #f0fdf4;   --ok-border: #bbf7d0;
  --warn: #b45309; --warn-soft: #fffbeb; --warn-border: #fde68a;
  --err: #b91c1c;  --err-soft: #fef2f2;  --err-border: #fecaca;
  --info: #1d4ed8; --info-soft: #eff6ff; --info-border: #bfdbfe;
  --shadow-pop: 0 1px 2px rgb(0 0 0 / 4%), 0 8px 24px rgb(0 0 0 / 8%);
  --overlay: rgb(9 9 11 / 40%);
  --code-bg: #fafafa;

  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 14px; --fs-md: 16px; --fs-lg: 20px; --fs-xl: 24px;
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-full: 999px;
  --ctl-h: 34px; --ctl-h-sm: 28px;
  --side-w: 232px; --content-max: 1180px; --content-narrow: 880px; --aside-w: 320px; --topbar-h: 48px;
  --gutter: 32px;
}
@media (max-width: 760px) {
  :root { --gutter: 16px; }
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --bg-subtle: #0f0f11;
    --bg-muted: #18181b;
    --bg-hover: #18181b;
    --bg-active: #27272a;
    --border: #27272a;
    --border-strong: #3f3f46;
    --control: #66666f;
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --text-faint: #8b8b94;
    --primary: #fafafa;
    --primary-hover: #e4e4e7;
    --primary-fg: #09090b;
    --danger-solid: #dc2626;
    --focus: #60a5fa;
    --ok: #4ade80;   --ok-soft: #052e16;   --ok-border: #14532d;
    --warn: #fbbf24; --warn-soft: #2a1a04; --warn-border: #713f12;
    --err: #f87171;  --err-soft: #2a0a0a;  --err-border: #7f1d1d;
    --info: #60a5fa; --info-soft: #0b1a33; --info-border: #1e3a8a;
    --shadow-pop: 0 1px 2px rgb(0 0 0 / 40%), 0 8px 24px rgb(0 0 0 / 50%);
    --overlay: rgb(0 0 0 / 60%);
    --code-bg: #0f0f11;
  }
}
`
