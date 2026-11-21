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
  const message = form.closest('dialog')?.querySelector('[data-sheet-message]') || null;
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
