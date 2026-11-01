import { components } from './design/components.js'
import { tokens } from './design/tokens.js'

export const adminStyle = tokens + components

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
  reauthState.querySelector('[data-reauth-text]').textContent = minutes ? 'Changes unlocked · ' + minutes + ' min' : 'Changes locked';
  reauthState.className = 'unlock ' + (minutes ? 'on' : 'off');
  reauthState.querySelector('use').setAttribute('href', minutes ? '#i-unlock' : '#i-lock');
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
  const selectors = ['mode', 'kind', 'auth', 'apiVersion', 'signIn'];
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
      if (!branch.if) continue;
      const chosen = matches(branch.if, current) ? branch.then : branch.else;
      if (!chosen) continue;
      for (const key of chosen.required || []) required.add(key);
      for (const rule of chosen.not ? chosen.not.anyOf || [chosen.not] : []) {
        if (rule.required?.length === 1) forbidden.add(rule.required[0]);
      }
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
      input.required = !input.disabled && required.has(key) && !(wrapper.hasAttribute('data-secret') && !wrapper.hasAttribute('data-ephemeral') && sameIdentity) &&
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
    if (saved.health) renderTestHealth(saved.health);
  }
}
const operationFilter = document.getElementById('ops-filter');
if (operationFilter) {
  // Filters apply live with JavaScript; without it the GET form reloads the filtered view.
  document.querySelector('[data-ops-apply]').hidden = true;
  const filterOperations = () => {
    const text = operationFilter.elements.q.value.trim().toLowerCase();
    const show = operationFilter.elements.show.value;
    const filtered = text !== '' || show !== 'all';
    let any = false;
    for (const group of document.querySelectorAll('[data-ops-group]')) {
      let visible = 0;
      for (const operation of group.querySelectorAll('[data-op]')) {
        const match = operation.dataset.op.includes(text) && (show === 'all' ||
          (show === 'selected' ? operation.querySelector('input').checked : operation.hasAttribute('data-delete')));
        operation.hidden = !match;
        if (match) visible++;
      }
      group.hidden = filtered && !visible;
      if (filtered && visible) group.open = true;
      any ||= visible > 0;
    }
    document.querySelector('[data-ops-empty]').hidden = any;
  };
  document.querySelector('[data-ops-filter]').addEventListener('input', filterOperations);
  operationFilter.addEventListener('submit', event => { event.preventDefault(); filterOperations(); });
}
for (const settings of document.querySelectorAll('[data-json-check]')) {
  const status = settings.closest('form').querySelector('[data-json-status]');
  const check = () => {
    try {
      const value = JSON.parse(settings.value);
      const valid = value !== null && typeof value === 'object' && !Array.isArray(value);
      status.textContent = valid ? 'Valid JSON object.' : 'Enter a JSON object, such as {}.';
      status.dataset.valid = String(valid);
    } catch (error) {
      status.textContent = 'Not valid JSON: ' + error.message;
      status.dataset.valid = 'false';
    }
  };
  settings.addEventListener('input', check);
  check();
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

function renderTestHealth(health) {
  const passed = health.status === 'ok';
  // The server renders both state badges from the status vocabulary; this only swaps them.
  document.querySelector('[data-tool-state]').replaceChildren(document.querySelector('template[data-state=' + (passed ? 'ok' : 'error') + ']').content.cloneNode(true));
  const step = document.querySelector('[data-test-checklist]');
  step.classList.remove('todo', 'done', 'fail');
  step.classList.add(passed ? 'done' : 'fail');
  step.querySelector('[data-step-state]').textContent = (passed ? 'Done' : 'Failed') + ': ';
  step.querySelector('b + span').textContent = passed ? 'Passed' : 'Failing: ' + (health.errorCode || 'error');
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('class', 'i');
  mark.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
  mark.firstChild.setAttribute('href', passed ? '#i-check' : '#i-x');
  step.querySelector('.mark').replaceChildren(mark);
  const checked = document.querySelector('[data-check-time]');
  checked.textContent = health.checkedAt === null ? 'never' : new Date(health.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  checked.title = health.checkedAt === null ? '' : new Date(health.checkedAt).toISOString();
  const detail = health.diagnostic;
  document.querySelector('[data-check-failure]').hidden = !health.errorCode;
  document.querySelector('[data-check-summary]').textContent = detail ? [detail.message, detail.hint].filter(Boolean).join(' ') : '';
  document.querySelector('[data-check-error]').textContent = health.errorCode || '';
  const inspect = document.querySelector('[data-inspect-certificate]');
  if (inspect && health.errorCode === 'UPSTREAM_TLS_FAILED') inspect.hidden = false;
  document.querySelector('[data-check-diagnostic]').textContent = detail
    ? [detail.stage, detail.host, detail.toolCode, detail.providerCode, detail.message, detail.hint, detail.issuer, detail.trust].filter(Boolean).join('\\n') : '';
}

let pendingAction = false;
function showCertificateInspection(result) {
  const dialog = document.getElementById('certificate-inspection');
  const details = dialog.querySelector('[data-certificate-details]');
  dialog.querySelector('[data-certificate-error]').textContent = '';
  details.replaceChildren();
  const line = (parent, text, warning = false) => {
    const element = document.createElement('p');
    element.textContent = text;
    if (warning) element.setAttribute('role', 'alert');
    parent.append(element);
  };
  line(details, 'Hostname: ' + result.hostname);
  line(details, result.reason);
  line(details, 'Leaf expires: ' + result.chain[0].expiresAt);
  line(details, 'Trust anchor expires: ' + result.anchor.expiresAt);
  for (const warning of result.warnings) line(details, warning, true);
  for (const fingerprint of result.previousFingerprints) line(details, 'Previously trusted endpoint SHA-256: ' + fingerprint);
  for (const certificate of result.chain) {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = certificate.subject;
    section.append(heading);
    line(section, 'Issuer: ' + certificate.issuer);
    line(section, 'Names: ' + (certificate.subjectAlternativeNames || 'No subject alternative names'));
    line(section, 'Hostname matches: ' + certificate.matchesHostname);
    line(section, 'Valid from: ' + certificate.validFrom + '; expires: ' + certificate.expiresAt);
    line(section, 'Expired: ' + certificate.expired + '; not yet valid: ' + certificate.notYetValid);
    line(section, 'Key: ' + certificate.keyType + ' ' + (certificate.keyBits ?? 'unknown') + ' bits; signature: ' + certificate.signatureAlgorithm);
    line(section, 'Self-signed: ' + certificate.selfSigned + '; CA: ' + certificate.ca);
    const label = document.createElement('label');
    label.textContent = 'SHA-256 fingerprint (select to copy)';
    const fingerprint = document.createElement('input');
    fingerprint.readOnly = true;
    fingerprint.value = certificate.fingerprint;
    fingerprint.addEventListener('click', () => fingerprint.select());
    label.append(fingerprint);
    section.append(label);
    details.append(section);
  }
  if (result.verificationError && result.anchor.fingerprint !== result.chain[0].fingerprint) {
    line(details, 'Issuing CA to trust: ' + result.anchor.subject + '; SHA-256: ' + result.anchor.fingerprint);
  }
  const form = dialog.querySelector('[data-trust-certificate]');
  form.hidden = !result.verificationError;
  form.elements.inspectionId.value = result.inspectionId;
  const hasCA = result.anchor.ca && result.anchor.fingerprint !== result.chain[0].fingerprint;
  const supportsPin = Boolean(form.elements.mode.querySelector('option[value="pin"]'));
  if (!supportsPin && !hasCA) {
    form.hidden = true;
    line(details, 'This tool requires an issuing CA. Configure the server trusted CA bundle for a self-signed endpoint.', true);
  }
  form.elements.mode.required = true;
  form.elements.mode.value = hasCA ? 'ca' : result.chain[0].selfSigned ? 'pin' : '';
  form.elements.mode.querySelector('option[value="ca"]').disabled = !hasCA;
  if (supportsPin && result.verificationError && !hasCA && !result.chain[0].selfSigned) {
    line(details, 'CA trust is unavailable because no issuing CA was obtained. Choose strict leaf pinning explicitly.', true);
  }
  dialog.querySelector('[data-close-certificate]').onclick = () => dialog.close();
  dialog.showModal();
}
async function connectGithub(connection, csrf, message) {
  const panel = document.querySelector('[data-github-authorization]');
  const status = panel.querySelector('[data-github-status]');
  const cancel = panel.querySelector('[data-cancel-github]');
  cancel.disabled = false;
  const link = panel.querySelector('[data-github-link]');
  panel.hidden = false;
  panel.querySelector('[data-github-code]').textContent = connection.userCode;
  link.href = connection.verificationUri;
  link.textContent = connection.verificationUri;
  let cancelled = false;
  let cancellation;
  let release;
  const send = async action => {
    const request = () => fetch('/v1/admin/tools/gh-axi/device/' + action, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ connectionId: connection.connectionId, _csrf: csrf }) });
    let response = await request();
    if (response.status === 401 && (await response.clone().json()).error?.code === 'REAUTH_REQUIRED') {
      if (await reauthenticate(csrf)) response = await request();
    }
    return response;
  };
  cancel.onclick = () => {
    if (cancelled) return;
    cancelled = true;
    cancellation = send('cancel').then(response => {
      status.textContent = response.ok ? 'Connection cancelled. The saved credential is unchanged.' : 'Cancellation could not be confirmed. Reload to check the credential.';
    }).catch(() => { status.textContent = 'Cancellation could not be confirmed. Reload to check the credential.'; });
    if (release) release();
  };
  const countdown = () => {
    if (cancelled) return;
    const remaining = Math.max(0, Math.ceil((connection.expiresAt - Date.now()) / 1000));
    status.textContent = remaining ? 'Waiting for GitHub approval. Code expires in ' + remaining + ' seconds.' : 'Code expired. Start a new connection.';
  };
  countdown();
  const timer = setInterval(countdown, 1000);
  try {
    let interval = connection.interval;
    while (Date.now() < connection.expiresAt) {
      await new Promise(resolve => { const wait = setTimeout(resolve, interval * 1000); release = () => { clearTimeout(wait); resolve(); }; });
      release = undefined;
      if (cancelled) break;
      if (Date.now() >= connection.expiresAt) break;
      const response = await send('poll');
      if (cancelled) break;
      if (response.redirected) { location.assign(response.url); return; }
      const result = await response.json();
      if (cancelled) break;
      if (!response.ok) {
        status.textContent = 'Connection stopped. Start a new connection after following the error below.';
        showError(message, result.error);
        return;
      }
      if (result.status === 'connected') { location.reload(); return; }
      interval = result.interval;
    }
    if (cancelled) await cancellation;
    else status.textContent = 'Code expired. Start a new connection.';
  } finally { clearInterval(timer); cancel.disabled = true; }
}
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
  // A filter control placed inside this form can belong to another form.
  const button = form.querySelector('button:not([form])');
  if (pendingAction || button.disabled) return;
  pendingAction = true;
  button.disabled = true;
  const message = form.hasAttribute('data-trust-certificate')
    ? form.closest('dialog').querySelector('[data-certificate-error]') : document.getElementById('message');
  message.textContent = '';
  const testResult = form.dataset.testTool ? document.querySelector('[data-test-result]') : null;
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
    if (response.ok && form.hasAttribute('data-connect-github')) {
      await connectGithub(await response.json(), body._csrf, message);
      return;
    }
    if (response.ok && form.hasAttribute('data-inspect-certificate')) {
      showCertificateInspection(await response.json());
      return;
    }
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
      const saved = await response.json();
      const normalized = (saved.normalizations || []).map(change => change.field + ': ' + change.reason + '.').join(' ');
      if (!form.querySelector('[data-save-and-test]').checked) {
        sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ message: 'Saved.' + (normalized ? ' ' + normalized : '') }));
        location.reload(); return;
      }
      let result = 'Saved. Test could not complete. Run Test connection again.';
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
      sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ message: result + (normalized ? ' ' + normalized : ''), health }));
      location.reload();
      return;
    }
    if (testResult) {
      const current = await readTestResponse(response);
      testResult.textContent = response.ok ? 'Test passed.' : 'Test failed.';
      renderTestHealth(current.health);
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
