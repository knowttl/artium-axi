import { components } from './design/components.js'
import { tokens } from './design/tokens.js'
import { reauthCompleteMessage } from '../../views/reauth.js'
import { beginSubmit, snapshotForm } from '../../views/submit.js'

export const adminStyle = tokens + components

export const reauthCompleteScript = `window.opener?.postMessage('${reauthCompleteMessage}', location.origin);`

export const adminScript = `
const hydrated = new Promise(resolve => document.addEventListener('astryx-hydrated', resolve, { once: true }));
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
  let astryxDraft;
  try {
    astryxDraft = snapshotForm(form);
    await hydrated;
  } finally { submission.release(); }
  form.dispatchEvent(Object.assign(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }), { astryxDraft }));
});
`
