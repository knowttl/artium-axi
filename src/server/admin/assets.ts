import { components } from './design/components.js'
import { tokens } from './design/tokens.js'
import { scriptedFormSelector } from '../../views/action-form.js'
import { reauthCompleteMessage, reauthRequestEvent } from '../../views/reauth.js'
import { beginSubmit, snapshotForm } from '../../views/submit.js'
import { retestScript } from './retest.js'

export const adminStyle = tokens + components

export const reauthCompleteScript = `window.opener?.postMessage('${reauthCompleteMessage}', location.origin);`

export const adminScript = `
${retestScript}
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
    certificate.hidden = forbidden.has('auth') || current.auth !== 'certificate' ||
      !inputs.some(input => ['thumbprint', 'thumbprintSha256'].includes(input.dataset.profileField));
    const combined = !certificate.hidden && editor.querySelector('[data-certificate-pem]').value !== '';
    for (const input of inputs) {
      if (input.hasAttribute('data-tls-input')) continue;
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
  for (const input of editor.querySelectorAll('[data-tls-input][data-profile-clearable]')) {
    input.addEventListener('input', () => { input.dataset.tlsEdited = 'true'; });
    input.addEventListener('change', () => { input.dataset.tlsEdited = 'true'; });
  }
  for (const upload of editor.querySelectorAll('[data-tls-file]')) upload.addEventListener('change', async () => {
    const file = upload.files[0];
    if (!file) return;
    const content = await file.text();
    if (upload.files[0] !== file) return;
    editor.querySelector('[data-profile-field="' + upload.dataset.tlsFile + '"]').value = content;
    update();
  });
  editor.querySelector('[data-certificate-file]').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const content = await file.text();
    if (event.target.files[0] !== file) return;
    editor.querySelector('[data-certificate-pem]').value = content;
    update();
  });
  update();
}
const savedTest = sessionStorage.getItem('credential-test:' + location.pathname);
let latestTestResult;
let testViewHydrated = false;
document.addEventListener('astryx-hydrated', () => {
  testViewHydrated = true;
  if (latestTestResult) renderTestResult(latestTestResult);
}, { once: true });
if (savedTest) {
  sessionStorage.removeItem('credential-test:' + location.pathname);
  const result = document.querySelector('[data-test-result]');
  if (result) {
    const saved = JSON.parse(savedTest);
    latestTestResult = {
      message: saved.diagnosticVersion === 1 ? saved.message : 'Details unavailable. Run Test connection again.',
      health: saved.health
    };
    result.textContent = latestTestResult.message;
  }
}

// The confirmation dialog in the React tree answers; a request made before hydration waits for it, so nothing is sent unconfirmed.
function confirmChange(form, fallbackAction) {
  const action = form.dataset.confirmAction || fallbackAction;
  return new Promise(resolve => {
    const request = new CustomEvent('artium-confirm', { cancelable: true, detail: { action, title: form.dataset.confirmTitle || action + '?',
      consequence: form.dataset.confirm, typedName: '', resolve } });
    if (document.dispatchEvent(request)) document.addEventListener('astryx-hydrated', () => document.dispatchEvent(request), { once: true });
  });
}

// A form with no message area of its own reports through the toast host in the React tree once it has hydrated.
const hydrated = new Promise(resolve => document.addEventListener('astryx-hydrated', resolve, { once: true }));
function say(target, text, reload = false) {
  if (!target) {
    hydrated.then(() => document.dispatchEvent(new CustomEvent('artium-toast', { detail: { text, reload } })));
    return;
  }
  target.textContent = text;
  if (reload) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-sm';
    button.textContent = 'Reload latest';
    button.addEventListener('click', () => location.reload());
    target.append(document.createElement('br'), button);
  }
  if (text) target.focus();
}

function showError(target, error) {
  say(target, error.message + ' ' + error.next + ' (' + error.code + ')', error.code === 'REVISION_CONFLICT');
}

// The identity confirmation dialog in the React tree answers; a request made before hydration waits for it, so nothing is sent unconfirmed.
function reauthenticate(csrf) {
  return new Promise(resolve => {
    const request = new CustomEvent('${reauthRequestEvent}', { cancelable: true, detail: { csrf, resolve } });
    if (document.dispatchEvent(request)) document.addEventListener('astryx-hydrated', () => document.dispatchEvent(request), { once: true });
  });
}

async function readTestResponse(response) {
  const result = await response.json();
  if (!response.ok) {
    const code = Object.hasOwn(retestErrors, result?.error?.code) ? result.error.code : 'INTERNAL_ERROR';
    const diagnostic = structuredDiagnostic(result?.error?.diagnostic);
    const error = { code, message: retestErrors[code], next: retestNext[code] };
    return { error, health: { status: 'error', checkedAt: diagnostic?.checkedAt ?? null,
      errorCode: code, diagnostic } };
  }
  const health = result;
  if (health.status !== 'ok' || !Number.isInteger(health.checkedAt) ||
      !Number.isInteger(health.credentialRevision) || health.errorCode !== null) throw new Error();
  return { health: { status: 'ok', checkedAt: health.checkedAt, credentialRevision: health.credentialRevision, errorCode: null } };
}

function renderTestResult(result) {
  latestTestResult = result;
  document.querySelector('[data-test-result]').textContent = result.message;
  const { health } = result;
  const step = document.querySelector('[data-test-checklist]');
  if (!health || !step) return;
  const errorCode = Object.hasOwn(retestErrors, health.errorCode) ? health.errorCode : null;
  const detail = structuredDiagnostic(health.diagnostic);
  document.querySelector('[data-check-failure]').hidden = !errorCode;
  document.querySelector('[data-check-summary]').textContent = retestErrors[errorCode] || '';
  document.querySelector('[data-check-error]').textContent = errorCode || '';
  const inspect = document.querySelector('[data-inspect-certificate]');
  if (inspect && errorCode === 'UPSTREAM_TLS_FAILED') inspect.hidden = false;
  document.querySelector('[data-check-diagnostic]').textContent = detail
    ? [detail.stage, detail.toolCode, detail.transportCode, detail.providerCode, detail.upstreamStatus, detail.trust].filter(value => value !== undefined).join('\\n') : 'Details unavailable.';

  const checkedAt = health.checkedAt === null ? null : new Date(health.checkedAt).toISOString();
  const checked = document.querySelector('[data-check-time]');
  const fallback = document.querySelector('[data-check-time-fallback]');
  if (!testViewHydrated) {
    checked.hidden = true;
    fallback.hidden = false;
    if (checkedAt === null) {
      fallback.textContent = 'never';
    } else {
      const time = document.createElement('time');
      time.dateTime = time.title = time.textContent = checkedAt;
      fallback.replaceChildren(time);
    }
    return;
  }
  fallback.hidden = true;
  checked.hidden = false;
  document.dispatchEvent(new CustomEvent('artium-check-time', { detail: checkedAt }));

  const passed = health.status === 'ok';
  // The server renders both state badges from the status vocabulary; this only swaps them.
  document.querySelector('[data-tool-state]').replaceChildren(document.querySelector('[data-outcome=' + (passed ? 'ok' : 'error') + ']').firstChild.cloneNode(true));
  step.classList.remove('todo', 'done', 'fail');
  step.classList.add(passed ? 'done' : 'fail');
  step.querySelector('[data-step-state]').textContent = (passed ? 'Done' : 'Failed') + ': ';
  step.querySelector('b + span').textContent = passed ? 'Passed' : 'Failing: ' + (errorCode || 'error');
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('class', 'i');
  mark.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
  mark.firstChild.setAttribute('href', passed ? '#i-check' : '#i-x');
  step.querySelector('.mark').replaceChildren(mark);
}

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
  const nameForm = dialog.querySelector('[data-certificate-name-form]');
  nameForm.hidden = !result.nameChange || Boolean(result.nameChange.refusalReason);
  if (result.nameChange?.refusalReason) line(details, result.nameChange.refusalReason, true);
  if (!nameForm.hidden) {
    nameForm.elements.inspectionId.value = result.inspectionId;
    nameForm.querySelector('button').textContent = 'Use ' + result.nameChange.certificateName + ' as the name and keep connecting to ' + result.nameChange.connectAddress;
  }
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
  form.hidden = !result.pinRequired && (result.trustMode ? !result.rotation : !result.verificationError);
  let replacement = form.elements.replace;
  if (!replacement) {
    replacement = document.createElement('input');
    replacement.type = 'hidden';
    replacement.name = 'replace';
    replacement.dataset.type = 'boolean';
    form.append(replacement);
  }
  replacement.value = String(result.rotation);
  form.querySelector('button').textContent = result.rotation ? 'Replace trusted certificate' : 'Trust this certificate';
  if (result.rotation) line(details, 'Confirm the new fingerprint to replace saved trust. The existing trust mode is preserved.', true);
  form.elements.inspectionId.value = result.inspectionId;
  form.elements.confirmedFingerprint.checked = false;
  form.elements.confirmedFingerprint.value = result.chain[0].fingerprint;
  const hasCA = result.rotation && result.trustMode === 'ca' || result.anchor.ca && result.anchor.fingerprint !== result.chain[0].fingerprint;
  const supportsPin = Boolean(form.elements.mode.querySelector('option[value="pin"]'));
  if (!supportsPin && !hasCA) {
    form.hidden = true;
    line(details, 'This tool requires an issuing CA. Configure the server trusted CA bundle for a self-signed endpoint.', true);
  }
  form.elements.mode.required = true;
  form.elements.mode.value = result.pinRequired ? 'pin' : result.rotation ? result.trustMode : hasCA ? 'ca' : result.chain[0].selfSigned ? 'pin' : '';
  for (const option of form.elements.mode.options) option.disabled = result.rotation && option.value !== result.trustMode;
  form.elements.mode.querySelector('option[value="ca"]').disabled = result.pinRequired || !hasCA || result.rotation && result.trustMode !== 'ca';
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
${snapshotForm.toString()}
${beginSubmit.toString()}
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('[data-api]')) return;
  event.preventDefault();
  if (event.astryxDraft) return;
  const { submitter } = event;
  const submission = beginSubmit(form, submitter);
  if (!submission) return;
  const { button, release } = submission;
  if (!form.matches('${scriptedFormSelector}')) {
    let astryxDraft;
    try {
      astryxDraft = snapshotForm(form);
      await hydrated;
    } finally { release(); }
    form.dispatchEvent(Object.assign(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }), { astryxDraft }));
    return;
  }
  const message = form.hasAttribute('data-trust-certificate') || form.hasAttribute('data-certificate-name-form')
    ? form.closest('dialog').querySelector('[data-certificate-error]')
    : form.closest('dialog')?.querySelector('[data-sheet-message]') || null;
  try {
    say(message, '');
    const testResult = form.dataset.testTool ? document.querySelector('[data-test-result]') : null;
    if (testResult) testResult.textContent = '';
    const fields = new FormData(form);
    const body = Object.fromEntries(fields);
    const typedName = form.dataset.confirm ? await confirmChange(form, button.textContent.trim()) : null;
    if (form.dataset.confirm && typedName === null) {
      const dialog = document.getElementById('confirmation');
      if (dialog.open) await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
      button.disabled = false;
      button.focus();
      return;
    }
    if (form.dataset.confirm) body._confirm = form.dataset.confirmToken;
    const profileFields = form.querySelectorAll('[data-profile-field]');
    if (profileFields.length) {
      body.value = Object.create(null);
      for (const input of profileFields) {
        delete body[input.name];
        if (input.disabled || input.value === '' && !input.hasAttribute('data-profile-clearable')) continue;
        if (input.hasAttribute('data-tls-input') && input.hasAttribute('data-profile-clearable') && !input.dataset.tlsEdited &&
          [...form.querySelectorAll('[data-profile-field="origin"], [data-profile-field="url"]')].some(endpoint => endpoint.value !== (endpoint.dataset.saved ?? endpoint.defaultValue))) continue;
        try {
          const path = input.hasAttribute('data-tls-input') ? input.dataset.profileField.split('.') : [input.dataset.profileField];
          const key = path.pop();
          const parent = path.reduce((value, name) => value[name] ??= Object.create(null), body.value);
          parent[key] = input.value === '' ? null : input.dataset.profileType === 'list' ? input.value.split(/\\r?\\n/).map(value => value.trim()).filter(Boolean) : input.dataset.profileType === 'json' ? JSON.parse(input.value) : input.value;
        }
        catch { say(message, 'Enter valid JSON in ' + input.dataset.profileField + '.'); return; }
      }
      for (const input of form.querySelectorAll('[data-tls-remove]:checked')) body.value[input.dataset.tlsRemove] = null;
      const certificate = form.querySelector('[data-certificate]:not([hidden]) [data-certificate-pem]');
      if (certificate?.value) body.value.certificatePem = certificate.value;
    }
    for (const input of form.querySelectorAll('[data-type]')) {
      if (input.dataset.type === 'boolean') body[input.name] = input.type === 'checkbox' ? input.checked : input.value === 'true';
      if (input.dataset.type === 'number') body[input.name] = Number(input.value);
    }
    if (form.hasAttribute('data-create-token')) {
      const tools = [];
      for (const input of form.querySelectorAll('[data-token-tool]')) {
        const commands = [...form.querySelectorAll('[data-token-command]')].filter(item => item.dataset.tokenCommand === input.dataset.tokenTool && item.checked).map(item => item.value);
        const instances = [...form.querySelectorAll('[data-token-instance]')].filter(item => item.dataset.tokenInstance === input.dataset.tokenTool && item.checked).map(item => item.value);
        const scope = instances.length ? { instances } : {};
        if (input.checked) tools.push({ tool: input.dataset.tokenTool, ...scope });
        if (commands.length) tools.push({ tool: input.dataset.tokenTool, commands, ...scope });
      }
      body.scope = { tools };
      body.readOnly = form.elements.readOnly.checked;
      body.reusable = form.elements.reusable.checked;
      body.expiresAt = body.expiryType === 'date' ? new Date(body.expiryDate).getTime() : Date.now() + Math.floor(Number(body.duration) * 3600000);
      delete body.expiryType; delete body.expiryDate; delete body.duration;
    }
    if (form.hasAttribute('data-token-settings')) {
      body.maxLifetimeMs = Math.floor(Number(body.maxLifetimeHours) * 3600000);
      body.ssoWindowMs = Math.round(Number(body.ssoWindowDays) * 86400000);
      delete body.maxLifetimeHours;
      delete body.ssoWindowDays;
    }
    if (form.querySelector('[name=roleIds]')) body.roleIds = fields.getAll('roleIds');
    let confirmationRetried = false;
    const send = async () => {
      const request = () => fetch(form.action, { method: form.dataset.method || 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      let response = await request();
      if (!confirmationRetried && response.status === 428 && response.headers.get('x-artium-confirmation')) {
        confirmationRetried = true;
        body._confirm = response.headers.get('x-artium-confirmation');
        response = await request();
      }
      return response;
    };
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
    if (response.ok && form.hasAttribute('data-trust-certificate')) {
      message.textContent = 'Certificate trusted. Testing connection…';
      const current = await retestConnection(form.dataset.trustTestUrl, body._csrf);
      if (current.redirect) { location.assign(current.redirect); return; }
      const result = current.diagnostic ? renderRetestDiagnostic(current.diagnostic) : 'Connected';
      sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ diagnosticVersion: 1, message: result, health: current.health }));
      location.reload();
      return;
    }
    if (response.ok && form.dataset.saveTool) {
      const saved = await response.json();
      const normalized = (saved.normalizations || []).map(change => change.field + ': ' + change.reason + '.').join(' ');
      if (!form.querySelector('[data-save-and-test]').checked) {
        sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ diagnosticVersion: 1, message: 'Saved.' + (normalized ? ' ' + normalized : '') }));
        location.reload(); return;
      }
      let result = 'Saved. Test could not complete. Run Test connection again.';
      let health;
      try {
        const tested = await fetch('/v1/admin/tools/' + form.dataset.saveTool + '/instances/' + (form.dataset.saveInstance || body.name) + '/test', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ _csrf: body._csrf }) });
        if (tested.redirected) { location.assign(tested.url); return; }
        const current = await readTestResponse(tested);
        health = current.health;
        result = tested.ok ? 'Saved. Test passed.' : 'Saved. Test failed.';
        if (current.error) { const error = current.error; result += ' ' + error.message + ' ' + error.next + ' (' + error.code + ')'; }
      } catch { /* The credential is saved even when its test cannot complete. */ }
      sessionStorage.setItem('credential-test:' + location.pathname, JSON.stringify({ diagnosticVersion: 1, message: result + (normalized ? ' ' + normalized : ''), health }));
      location.reload();
      return;
    }
    if (testResult) {
      const current = await readTestResponse(response);
      renderTestResult({ message: response.ok ? 'Test passed.' : 'Test failed.', health: current.health });
      if (current.error) showError(message, current.error);
      return;
    }
    if (!response.ok) {
      const result = await response.json();
      showError(message, result.error);
      return;
    }
    if (form.hasAttribute('data-create-token')) {
      const result = await response.json();
      const dialog = document.getElementById('created-token');
      const field = dialog.querySelector('[data-created-token]');
      field.value = result.token;
      dialog.addEventListener('close', () => { field.value = ''; location.reload(); }, { once: true });
      window.addEventListener('pagehide', () => { field.value = ''; }, { once: true });
      dialog.querySelector('[data-close-created-token]').addEventListener('click', () => dialog.close(), { once: true });
      dialog.showModal(); field.focus(); field.select();
      return;
    }
    sessionStorage.setItem('artium-toast', 'Change saved.');
    location.reload();
  } catch { say(message, 'Request could not complete. Reload the page to check the current state before trying again.'); }
  finally { release(); }
});
`
