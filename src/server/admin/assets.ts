export const adminStyle = `
body { margin: 0; color: #203349; background: #edf2f7; font: 16px/1.5 "Segoe UI", sans-serif; }
main { max-width: 1100px; width: 100%; min-width: 0; box-sizing: border-box; margin: auto; padding: 28px; }
nav { display: flex; flex-direction: column; gap: 8px; padding: 24px 16px; }
nav a { padding: 8px 12px; text-decoration: none; border-left: 4px solid transparent; }
nav a[aria-current=page] { background: #dce7f1; border-color: #31577a; font-weight: 600; }
.site-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 16px 28px; padding: 16px 28px; background: white; border-bottom: 2px solid #31577a; }
.site-header p, .site-header form { margin: 0; }
.brand { font-size: 24px; font-weight: 700; text-decoration: none; }
.site-header form { margin-left: auto; }
.page-layout { display: flex; max-width: 1400px; margin: auto; }
aside { flex: 0 0 190px; border-right: 1px solid #a5b4c3; }
.page-help { background: white; padding: 16px; border-left: 4px solid #31577a; }
.action-help { margin-top: 12px; font-size: 14px; }
dialog { color: #203349; border: 2px solid #31577a; padding: 24px; width: 480px; max-width: calc(100% - 48px); box-sizing: border-box; max-height: calc(100% - 48px); overflow: auto; }
dialog::backdrop { background: rgb(32 51 73 / 55%); }
.dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
button:disabled { opacity: .6; cursor: wait; }
a { color: #245781; } h1 { font-size: 32px; } h2 { font-size: 23px; margin-top: 0; }
section { background: white; padding: 24px; margin: 24px 0; border-left: 4px solid #31577a; }
form { margin: 16px 0; } label { display: block; margin: 10px 0; }
input:not([type=checkbox]), select { display: block; max-width: 100%; width: 320px; box-sizing: border-box; padding: 8px; }
pre { overflow-x: auto; }
textarea { display: block; width: 100%; box-sizing: border-box; padding: 8px; font: 14px/1.5 monospace; }
fieldset { border: 1px solid #a5b4c3; margin: 12px 0; }
.table-scroll { max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; }
caption { text-align: left; font-weight: 600; margin-bottom: 12px; }
th, td { padding: 12px; border-bottom: 1px solid #a5b4c3; overflow-wrap: anywhere; }
thead { background: #edf2f7; }
button { padding: 8px 16px; background: #31577a; color: white; border: 0; cursor: pointer; font: inherit; }
:focus-visible { outline: 3px solid #ab6500; outline-offset: 3px; }
details { border-top: 1px solid #a5b4c3; padding-top: 12px; } summary { cursor: pointer; }
[role=alert] { color: #9b2525; } small { overflow-wrap: anywhere; }
@media (max-width: 760px) { main { padding: 16px; } section { padding: 16px; } .site-header { position: static; padding: 16px; gap: 12px; } .page-layout { display: block; } aside { border-right: 0; border-bottom: 1px solid #a5b4c3; } nav { flex-direction: row; flex-wrap: wrap; padding: 8px; gap: 4px; } }
`

export const adminScript = `
for (const time of document.querySelectorAll('time[datetime]')) {
  time.textContent = new Date(time.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const reauthState = document.querySelector('[data-reauth-until]');
function updateReauthState() {
  if (!reauthState) return;
  const minutes = Math.max(0, Math.ceil((Number(reauthState.dataset.reauthUntil) - Date.now()) / 60000));
  reauthState.textContent = minutes ? 'Changes allowed for ' + minutes + ' min' : 'Password confirmation required for changes';
}
updateReauthState();
if (reauthState) setInterval(updateReauthState, 30000);

function confirmChange(consequence) {
  const dialog = document.getElementById('confirmation');
  dialog.querySelector('[data-consequence]').textContent = consequence;
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirmed'), { once: true });
    dialog.showModal();
  });
}

function showError(target, error) {
  target.textContent = error.message + ' ' + error.next + ' (' + error.code + ')';
  if (error.code === 'REVISION_CONFLICT') {
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload latest values';
    reload.addEventListener('click', () => location.reload());
    target.append(' ', reload);
  }
  target.focus();
}

function reauthenticate(csrf) {
  const dialog = document.getElementById('reauth-dialog');
  const form = dialog.querySelector('form');
  const button = form.querySelector('button:not([type=button])');
  const error = form.querySelector('[data-reauth-error]');
  dialog.returnValue = '';
  error.textContent = '';
  return new Promise(resolve => {
    let closed = false;
    const controller = new AbortController();
    const submit = async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      error.textContent = '';
      try {
        const response = await fetch('/v1/auth/reauth', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ _csrf: csrf, password: form.elements.password.value }), signal: controller.signal });
        if (closed) return;
        form.elements.password.value = '';
        if (!dialog.open) return;
        if (response.redirected) { location.assign(response.url); dialog.close('cancel'); return; }
        if (!response.ok) {
          showError(error, (await response.json()).error);
          form.elements.password.focus();
          return;
        }
        reauthState.dataset.reauthUntil = response.headers.get('x-artium-reauth-until');
        updateReauthState();
        dialog.close('confirmed');
      } catch { if (!closed) error.textContent = 'Password confirmation could not complete. Try again or cancel to keep your draft.'; }
      finally { if (!closed) button.disabled = false; }
    };
    form.addEventListener('submit', submit);
    dialog.addEventListener('close', () => {
      closed = true;
      controller.abort();
      button.disabled = false;
      form.removeEventListener('submit', submit);
      form.reset();
      resolve(dialog.returnValue === 'confirmed');
    }, { once: true });
    dialog.querySelector('[data-reauth-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    form.elements.password.focus();
  });
}

let pendingAction = false;
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.matches('[data-filters]')) {
    event.preventDefault();
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (value !== '') query.set(key, value);
    location.assign(form.action + '?' + query);
    return;
  }
  if (!form.matches('[data-api]')) return;
  event.preventDefault();
  const button = form.querySelector('button');
  if (pendingAction || button.disabled) return;
  pendingAction = true;
  button.disabled = true;
  const message = document.getElementById('message');
  message.textContent = '';
  const testResult = form.dataset.testTool ? form.closest('section').querySelector('[data-test-result]') : null;
  if (testResult) testResult.textContent = '';
  const fields = new FormData(form);
  const body = Object.fromEntries(fields);
  try {
    if (form.dataset.confirm && !await confirmChange(form.dataset.confirm)) return;
    const profileFields = form.querySelectorAll('[data-profile-field]');
    if (profileFields.length) {
      body.value = Object.create(null);
      for (const input of profileFields) {
        delete body[input.name];
        if (input.value === '') continue;
        try { body.value[input.dataset.profileField] = input.dataset.profileType === 'json' ? JSON.parse(input.value) : input.value; }
        catch { message.textContent = 'Enter valid JSON in ' + input.dataset.profileField + '.'; message.focus(); return; }
      }
    }
    for (const input of form.querySelectorAll('[data-type]')) {
      if (input.dataset.type === 'boolean') body[input.name] = input.type === 'checkbox' ? input.checked : input.value === 'true';
      if (input.dataset.type === 'number') body[input.name] = Number(input.value);
      if (input.dataset.type === 'array') body[input.name] = fields.getAll(input.name);
      if (input.dataset.type === 'json') {
        try { body[input.name] = JSON.parse(input.value); }
        catch { message.textContent = 'Enter valid JSON in ' + input.name + '.'; message.focus(); return; }
      }
    }
    if (form.querySelector('[name=roleIds]')) body.roleIds = fields.getAll('roleIds');
    const send = () => fetch(form.action, { method: form.dataset.method || 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    let response = await send();
    if (response.status === 401 && !response.redirected) {
      const result = await response.clone().json();
      if (result.error.code === 'REAUTH_REQUIRED') {
        if (!await reauthenticate(body._csrf)) return;
        response = await send();
      }
    }
    if (response.redirected) { location.assign(response.url); return; }
    if (testResult) testResult.textContent = response.ok ? 'Test passed.' : 'Test failed.';
    if (!response.ok) {
      const result = await response.json();
      showError(message, result.error);
      if (!testResult) return;
    }
    if (testResult) {
      try {
        const refreshed = await fetch('/v1/admin/tools');
        if (refreshed.redirected) { location.assign(refreshed.url); return; }
        if (!refreshed.ok) throw new Error();
        const data = await refreshed.json();
        const tool = data.tools.find(tool => tool.name === form.dataset.testTool);
        document.getElementById('status-' + tool.name).textContent = tool.health.status;
        const checked = form.closest('section').querySelector('[data-check-time]');
        checked.textContent = tool.health.checkedAt === null ? 'Not checked' : new Date(tool.health.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        checked.title = tool.health.checkedAt === null ? '' : new Date(tool.health.checkedAt).toISOString();
        form.closest('section').querySelector('[data-check-error]').textContent = tool.health.errorCode || '';
      } catch { message.textContent += ' Tool health could not refresh. Reload the page to check the current status.'; }
      return;
    }
    if (form.dataset.successUrl) location.assign(form.dataset.successUrl);
    else location.reload();
  } catch { message.textContent = 'Request could not complete. Reload the page to check the current state before trying again.'; }
  finally { button.disabled = false; pendingAction = false; }
});
`
