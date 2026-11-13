import { errors } from '../../shared/errors.js'
import { diagnosticCodes, diagnosticStages, transportCodes, validDiagnosticCode, structuredDiagnostic } from '../../shared/diagnostic.js'

export const retestScript = `
const diagnosticCodes = ${JSON.stringify(diagnosticCodes)};
const diagnosticStages = ${JSON.stringify(diagnosticStages)};
const transportCodes = ${JSON.stringify(transportCodes)};
${validDiagnosticCode.toString()}
${structuredDiagnostic.toString()}
const retestErrors = ${JSON.stringify(Object.fromEntries(Object.entries(errors).map(([code, error]) => [code, error.message])))};
const retestNext = ${JSON.stringify(Object.fromEntries(Object.entries(errors).map(([code, error]) => [code, error.next])))};
function renderRetestDiagnostic(detail) {
  const status = detail.status === undefined ? '' : ' HTTP ' + detail.status + '.';
  if (detail.kind === 'network') return 'Connection test: Could not reach the artium admin server. Run Test connection again.';
  if (detail.kind === 'body') return 'Connection test: response body could not be read' +
    '.' + status + ' Check the connection for an interrupted response. Run Test connection again.';
  if (detail.kind === 'json') return 'Connection test: response was not valid JSON.' + status + ' Check the server or proxy response format. Run Test connection again.';
  if (detail.kind === 'schema') return 'Connection test: response did not match the connection-test format.' + status + ' Check server and client version compatibility. Run Test connection again.';
  return 'Connection test:' + status + (detail.errorCode ? ' ' + retestErrors[detail.errorCode] + ' (' + detail.errorCode + ').' : ' Server error code unavailable.') +
    (detail.stage ? ' Failed step: ' + detail.stage + '.' : '') + (detail.toolCode ? ' Code: ' + detail.toolCode + '.' : '') +
    (detail.transportCode ? ' Transport: ' + detail.transportCode + '.' : '') +
    (detail.providerCode ? ' Provider: ' + detail.providerCode + '.' : '') + (detail.upstreamStatus === undefined ? '' : ' Upstream HTTP ' + detail.upstreamStatus + '.') +
    (detail.trust ? ' Certificate trust: ' + detail.trust + '.' : '') + ' Run Test connection again.';
}
async function retestConnection(url, csrf) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Artium-Retest': '1' }, body: JSON.stringify({ _csrf: csrf }) });
  } catch (error) {
    return { diagnostic: { kind: 'network' } };
  }
  if (response.redirected) return { redirect: response.url };
  const status = response.status;
  let result;
  try { result = await response.json(); }
  catch (error) {
    return { diagnostic: { kind: error?.name === 'SyntaxError' ? 'json' : 'body', status } };
  }
  if (!response.ok) {
    const error = result?.error;
    const errorCode = typeof error?.code === 'string' && Object.hasOwn(retestErrors, error.code) ? error.code : undefined;
    const detail = structuredDiagnostic(error?.diagnostic);
    return { diagnostic: { kind: 'http', status, errorCode, stage: detail?.stage, toolCode: detail?.toolCode, transportCode: detail?.transportCode, providerCode: detail?.providerCode, upstreamStatus: detail?.upstreamStatus, trust: detail?.trust } };
  }
  if (result?.status !== 'ok' || !Number.isSafeInteger(result.checkedAt) ||
      !Number.isSafeInteger(result.credentialRevision) || result.errorCode !== null) {
    return { diagnostic: { kind: 'schema', status } };
  }
  return { health: { status: 'ok', checkedAt: result.checkedAt, credentialRevision: result.credentialRevision, errorCode: null } };
}
`;
