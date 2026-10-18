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
.session-table { min-width: 1000px; }
.session-table time, .session-table button { white-space: nowrap; }
.audit-table { min-width: 1000px; }
.audit-table td:nth-child(2) { min-width: 320px; }
.audit-table th:nth-child(n+4), .audit-table td:nth-child(n+4) { min-width: 100px; }
caption { text-align: left; font-weight: 600; margin-bottom: 12px; }
th, td { padding: 12px; border-bottom: 1px solid #a5b4c3; overflow-wrap: anywhere; }
thead { background: #edf2f7; }
button { padding: 8px 16px; background: #31577a; color: white; border: 0; cursor: pointer; font: inherit; }
:focus-visible { outline: 3px solid #ab6500; outline-offset: 3px; }
details { border-top: 1px solid #a5b4c3; padding-top: 12px; } summary { cursor: pointer; }
[hidden] { display: none !important; }
[role=alert] { color: #9b2525; } small { overflow-wrap: anywhere; }
@media (max-width: 760px) { main { padding: 16px; } section { padding: 16px; } .site-header { position: static; padding: 16px; gap: 12px; } .page-layout { display: block; } aside { border-right: 0; border-bottom: 1px solid #a5b4c3; } nav { flex-direction: row; flex-wrap: wrap; padding: 8px; gap: 4px; } }
`

export const adminScript = `
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const input = button.parentElement.querySelector('input, textarea');
    const status = button.parentElement.querySelector('[data-copy-status]');
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = 'Copied.';
    } catch {
      input.focus(); input.select();
      status.textContent = 'Copy unavailable. Copy the selected text manually.';
    }
  });
}
for (const time of document.querySelectorAll('time[datetime]')) {
  time.textContent = new Date(time.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const reauthState = document.querySelector('[data-reauth-until]');
function updateReauthState() {
  if (!reauthState) return;
  const minutes = Math.max(0, Math.ceil((Number(reauthState.dataset.reauthUntil) - Date.now()) / 60000));
  reauthState.textContent = minutes ? 'Changes allowed for ' + minutes + ' min' : 'Identity confirmation required for changes';
}
updateReauthState();
if (reauthState) setInterval(updateReauthState, 30000);
if (document.querySelector('[data-sso-reauth-complete]') && window.opener) {
  window.opener.postMessage('artium-reauth-complete', location.origin);
}

for (const editor of document.querySelectorAll('[data-credential-editor]')) {
  const schema = JSON.parse(editor.dataset.schema);
  const identity = JSON.parse(editor.dataset.identity);
  const inputs = [...editor.querySelectorAll('[data-profile-field]')];
  const selectors = ['mode', 'kind', 'auth', 'apiVersion'];
  function values() {
    return Object.fromEntries(inputs.map(input => {
      let value = input.value || null;
      if (input.dataset.profileType === 'json' && value) { try { value = JSON.parse(value); } catch { value = null; } }
      return [input.dataset.profileField, value];
    }));
  }
  function matches(condition, current) {
    return (condition.required || []).every(key => current[key] !== null && current[key] !== undefined) &&
      Object.entries(condition.properties || {}).every(([key, rule]) => {
        if (rule.pattern && !rule['x-secret']) return typeof current[key] === 'string' && new RegExp(rule.pattern).test(current[key]);
        if (!selectors.includes(key)) return true;
        return (!Object.hasOwn(rule, 'const') || current[key] === rule.const) && (!rule.enum || rule.enum.includes(current[key]));
      });
  }
  function update() {
    const current = values();
    const branches = (schema.oneOf || []).filter(branch => matches({ properties: branch.properties }, current));
    const required = new Set(schema.required || []);
    const forbidden = new Set();
    for (const branch of branches) {
      for (const key of branch.required || []) required.add(key);
      for (const rule of branch.not ? branch.not.anyOf || [branch.not] : []) {
        if (rule.required?.length === 1) forbidden.add(rule.required[0]);
      }
    }
    for (const branch of schema.allOf || []) {
      if (branch.if && matches(branch.if, current)) for (const key of branch.then?.required || []) required.add(key);
    }
    // A delegated Graph token has no application authentication selector.
    if (current.mode === 'delegated') forbidden.add('auth');
    const sameIdentity = editor.dataset.configured === 'true' && Object.entries(identity).every(([key, value]) =>
      (forbidden.has(key) ? null : current[key] ?? null) === value);
    const certificate = editor.querySelector('[data-certificate]');
    certificate.hidden = forbidden.has('auth') || current.auth !== 'certificate';
    const combined = !certificate.hidden && editor.querySelector('[data-certificate-pem]').value !== '';
    for (const input of inputs) {
      const key = input.dataset.profileField;
      const wrapper = input.closest('[data-credential-field]');
      wrapper.hidden = forbidden.has(key);
      input.disabled = wrapper.hidden;
      input.required = !input.disabled && required.has(key) && !(wrapper.hasAttribute('data-secret') && sameIdentity) &&
        !(combined && ['privateKey', 'thumbprint', 'thumbprintSha256'].includes(key));
      const stored = wrapper.querySelector('[data-stored-secret]');
      if (stored) stored.textContent = sameIdentity ? 'Stored when configured. Leave blank to keep; enter a value to replace.' : 'Identity changed. Enter a new secret before saving.';
    }
  }
  editor.addEventListener('input', update);
  editor.addEventListener('change', update);
  editor.querySelector('[data-certificate-file]').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    editor.querySelector('[data-certificate-pem]').value = await file.text();
    update();
  });
  update();
}
const savedTest = sessionStorage.getItem('credential-test:' + location.pathname);
if (savedTest) {
  sessionStorage.removeItem('credential-test:' + location.pathname);
  const result = document.querySelector('[data-test-result]');
  if (result) {
    const saved = JSON.parse(savedTest);
    result.textContent = saved.message;
    if (saved.health) renderTestHealth(result.closest('section'), saved.health);
  }
}

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
    let popup;
    let popupClosed;
    const completed = async event => {
      if (event.origin !== location.origin || event.source !== popup || event.data !== 'artium-reauth-complete' || closed) return;
      try {
        const response = await fetch('/reauth?status=1', { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok || response.redirected) throw new Error();
        const status = await response.json();
        if (status.sessionId !== document.body.dataset.sessionId || status.until <= Date.now()) throw new Error();
        if (closed) return;
        reauthState.dataset.reauthUntil = status.until;
        updateReauthState();
        dialog.close('confirmed');
      } catch { if (!closed) error.textContent = 'Identity confirmation did not complete for this session. Try again or cancel to keep your draft.'; }
    };
    window.addEventListener('message', completed);
    const submit = async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      error.textContent = '';
      if (reauthState.dataset.reauthMethod === 'sso') {
        popup = window.open('/reauth', 'artium-reauth', 'popup,width=600,height=760');
        if (!popup) {
          error.textContent = 'Allow a popup for artium, then try again. Your draft stays here.';
          button.disabled = false;
          return;
        }
        popupClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(popupClosed);
            button.disabled = false;
            error.textContent = 'Confirmation window closed. Try again or cancel to keep your draft.';
          }
        }, 500);
        return;
      }
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
      clearInterval(popupClosed);
      popup?.close();
      window.removeEventListener('message', completed);
      button.disabled = false;
      form.removeEventListener('submit', submit);
      form.reset();
      resolve(dialog.returnValue === 'confirmed');
    }, { once: true });
    dialog.querySelector('[data-reauth-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    if (form.elements.password) form.elements.password.focus();
    else button.focus();
  });
}

async function readTestResponse(response) {
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    return { error, health: { status: 'error', checkedAt: error.diagnostic?.checkedAt ?? null,
      errorCode: error.code, diagnostic: error.diagnostic } };
  }
  const health = result;
  if (health.status !== 'ok' || !Number.isInteger(health.checkedAt) ||
      !Number.isInteger(health.credentialRevision) || health.errorCode !== null) throw new Error();
  return { health };
}

function renderTestHealth(section, health) {
  section.querySelector('[id^=status-]').textContent = health.status;
  section.querySelector('[data-test-checklist]').textContent =
    (health.status === 'ok' ? 'Done' : 'To do') + ': Pass Test credential below';
  const checked = section.querySelector('[data-check-time]');
  checked.textContent = health.checkedAt === null ? 'Not checked' : new Date(health.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  checked.title = health.checkedAt === null ? '' : new Date(health.checkedAt).toISOString();
  section.querySelector('[data-check-error]').textContent = health.errorCode || '';
  const detail = health.diagnostic;
  section.querySelector('[data-check-diagnostic]').textContent = detail
    ? [detail.stage, detail.host, detail.toolCode, detail.providerCode, detail.message, detail.hint, detail.issuer, detail.trust].filter(Boolean).join('\\n') : '';
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
        if (input.disabled || input.value === '') continue;
        try { body.value[input.dataset.profileField] = input.dataset.profileType === 'list' ? input.value.split(/\\r?\\n/).map(value => value.trim()).filter(Boolean) : input.dataset.profileType === 'json' ? JSON.parse(input.value) : input.value; }
        catch { message.textContent = 'Enter valid JSON in ' + input.dataset.profileField + '.'; message.focus(); return; }
      }
      const certificate = form.querySelector('[data-certificate]:not([hidden]) [data-certificate-pem]');
      if (certificate?.value) body.value.certificatePem = certificate.value;
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
    if (response.ok && form.hasAttribute('data-invitation-link')) {
      const result = await response.json();
      const dialog = document.getElementById('invitation-link');
      const link = dialog.querySelector('[data-claim-link]');
      link.value = new URL(result.claimPath, location.origin).href;
      dialog.addEventListener('close', () => location.reload(), { once: true });
      dialog.showModal();
      link.focus();
      link.select();
      return;
    }
    if (response.ok && form.dataset.saveTool) {
      if (!form.querySelector('[data-save-and-test]').checked) { location.reload(); return; }
      let result = 'Saved. Test could not complete. Run Test credential again.';
      let health;
      try {
        const tested = await fetch('/v1/admin/tools/' + form.dataset.saveTool + '/test', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ _csrf: body._csrf }) });
        if (tested.redirected) { location.assign(tested.url); return; }
        const current = await readTestResponse(tested);
        health = current.health;
        result = tested.ok ? 'Saved. Test passed.' : 'Saved. Test failed.';
        if (current.error) { const error = current.error; result += ' ' + error.message + ' ' + error.next + ' (' + error.code + ')'; }
      } catch { /* The credential is saved even when its test cannot complete. */ }
      sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ message: result, health }));
      location.reload();
      return;
    }
    if (testResult) {
      const current = await readTestResponse(response);
      testResult.textContent = response.ok ? 'Test passed.' : 'Test failed.';
      renderTestHealth(form.closest('section'), current.health);
      if (current.error) showError(message, current.error);
      return;
    }
    if (!response.ok) {
      const result = await response.json();
      showError(message, result.error);
      return;
    }
    if (form.dataset.successUrl) location.assign(form.dataset.successUrl);
    else location.reload();
  } catch { message.textContent = 'Request could not complete. Reload the page to check the current state before trying again.'; }
  finally { button.disabled = false; pendingAction = false; }
});
`
