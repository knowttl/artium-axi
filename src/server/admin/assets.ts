import { components } from './design/components.js'
import { tokens } from './design/tokens.js'
import { scriptedFormSelector, writeFormMessage } from '../../views/action-form.js'
import { reauthCompleteMessage, reauthRequestEvent } from '../../views/reauth.js'
import { beginSubmit, snapshotForm } from '../../views/submit.js'

export const adminStyle = tokens + components

export const reauthCompleteScript = `window.opener?.postMessage('${reauthCompleteMessage}', location.origin);`

export const adminScript = `
${writeFormMessage.toString()}
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
  writeFormMessage(target, text, reload);
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
  const message = form.hasAttribute('data-certificate-name-form')
    ? form.closest('dialog').querySelector('[data-certificate-error]')
    : form.closest('dialog')?.querySelector('[data-sheet-message]') || null;
  try {
    say(message, '');
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
    for (const input of form.querySelectorAll('[data-type]')) {
      if (input.dataset.type === 'boolean') body[input.name] = input.type === 'checkbox' ? input.checked : input.value === 'true';
      if (input.dataset.type === 'number') body[input.name] = Number(input.value);
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
    if (!response.ok) {
      const result = await response.json();
      showError(message, result.error);
      return;
    }
    sessionStorage.setItem('artium-toast', 'Change saved.');
    location.reload();
  } catch { say(message, 'Request could not complete. Reload the page to check the current state before trying again.'); }
  finally { release(); }
});
`
