export const adminStyle = `
body { margin: 0; color: #203349; background: #edf2f7; font: 16px/1.5 "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: auto; padding: 28px; }
nav { display: flex; flex-wrap: wrap; gap: 24px; border-bottom: 2px solid #31577a; padding-bottom: 16px; }
a { color: #245781; } h1 { font-size: 32px; } h2 { font-size: 23px; margin-top: 0; }
section { background: white; padding: 24px; margin: 24px 0; border-left: 4px solid #31577a; }
form { margin: 16px 0; } label { display: block; margin: 10px 0; }
input:not([type=checkbox]) { display: block; max-width: 100%; width: 320px; box-sizing: border-box; padding: 8px; }
fieldset { border: 1px solid #a5b4c3; margin: 12px 0; }
button { padding: 8px 16px; background: #31577a; color: white; border: 0; cursor: pointer; font: inherit; }
:focus-visible { outline: 3px solid #ab6500; outline-offset: 3px; }
details { border-top: 1px solid #a5b4c3; padding-top: 12px; } summary { cursor: pointer; }
[role=alert] { color: #9b2525; } small { overflow-wrap: anywhere; }
@media (max-width: 600px) { main { padding: 16px; } section { padding: 16px; } }
`

export const adminScript = `
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('[data-api]')) return;
  event.preventDefault();
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  const message = document.getElementById('message');
  message.textContent = '';
  const fields = new FormData(form);
  const body = Object.fromEntries(fields);
  for (const input of form.querySelectorAll('[data-type]')) {
    if (input.dataset.type === 'boolean') body[input.name] = input.type === 'checkbox' ? input.checked : input.value === 'true';
    if (input.dataset.type === 'number') body[input.name] = Number(input.value);
  }
  if (form.querySelector('[name=roleIds]')) body.roleIds = fields.getAll('roleIds');
  try {
    const response = await fetch(form.action, { method: form.dataset.method || 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.redirected) { location.assign(response.url); return; }
    if (!response.ok) {
      const result = await response.json();
      message.textContent = result.error.message + ' ' + result.error.next;
      message.focus();
      return;
    }
    location.reload();
  } catch { message.textContent = 'Request could not complete. Reload the page to check the current state before trying again.'; }
  finally { button.disabled = false; }
});
`
