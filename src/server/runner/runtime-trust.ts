import { buildCredentialTlsOptions, certificatePinError, certificatePinMismatchMessage, classifyCertificateFailure, observeCertificate } from '../credential-tls.js'

// Both runtimes keep native chain, hostname and date verification. The extra
// fingerprint check runs before a verified socket can carry application data.
export const nodeTrustBootstrap = String.raw`
const tls = require('node:tls');
const { syncBuiltinESMExports } = require('node:module');
const pins = JSON.parse(require('node:fs').readFileSync(process.env.ARTIUM_CERTIFICATE_PINS, 'utf8'));
const original = tls.connect;
const certificatePinMismatchMessage = ${JSON.stringify(certificatePinMismatchMessage)};
const certificatePinError = ${certificatePinError.toString()};
const classifyCertificateFailure = ${classifyCertificateFailure.toString()};
const observeCertificate = ${observeCertificate.toString()};
const buildOptions = ${buildCredentialTlsOptions.toString()};
tls.connect = function (...args) {
  const options = typeof args[0] === 'object' ? { ...args[0] } : {
    port: args[0], ...(typeof args[1] === 'string' ? { host: args[1] } : {}),
    ...args.find((value, index) => index > 0 && value && typeof value === 'object')
  };
  const host = (options.servername || options.host || 'localhost').replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(options.port || options.socket?.remotePort || 443);
  const expected = pins.filter(pin => pin.hostname === host && pin.port === port);
  const scoped = buildOptions(tls, expected, options.ca);
  const check = options.checkServerIdentity;
  const socket = original.call(this, { ...options, ...scoped,
    session: undefined,
    checkServerIdentity(hostname, peer) {
      return scoped.checkServerIdentity(hostname, peer) || check?.(hostname, peer);
    }
  }, args.find(value => typeof value === 'function'));
  if (!expected.some(pin => pin.mode === 'pin') || expected.some(pin => pin.mode === 'ca')) return socket;
  const emit = socket.emit;
  let failure;
  socket.emit = function (event, ...values) {
    if (event === 'close' && failure) {
      void failure.then(() => emit.call(this, event, ...values));
      return true;
    }
    if (event !== 'error') return emit.call(this, event, ...values);
    failure = classifyCertificateFailure(values[0], expected, socket.getPeerCertificate()?.fingerprint256,
      () => observeCertificate(original, { ...options, host, port })).then(error => emit.call(this, event, error));
    return true;
  };
  return socket;
};
syncBuiltinESMExports();
`

export const pythonTrustBootstrap = String.raw`
import hashlib, json, os, socket, ssl
with open(os.environ['ARTIUM_CERTIFICATE_PINS']) as source:
    _pins = json.load(source)
_wrap_socket = ssl.SSLContext.wrap_socket
_handshake = ssl.SSLSocket.do_handshake

def _certificate_failure(expected, peer, host, failure=None, certificate=None):
    fingerprints = [pin['leafFingerprint'].replace(':', '').upper() for pin in expected if pin['mode'] == 'pin']
    if any(pin['mode'] == 'ca' for pin in expected) or not fingerprints:
        return failure
    if certificate is None and isinstance(failure, ssl.SSLCertVerificationError):
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            with socket.create_connection(peer, timeout=3) as raw:
                with _wrap_socket(context, raw, server_hostname=host, do_handshake_on_connect=False) as diagnostic:
                    _handshake(diagnostic)
                    certificate = diagnostic.getpeercert(binary_form=True)
        except (OSError, ValueError):
            return failure
    if certificate and hashlib.sha256(certificate).hexdigest().upper() not in fingerprints:
        return ssl.SSLCertVerificationError(${JSON.stringify(certificatePinMismatchMessage)})
    return failure

def _verified_wrap(self, sock, server_side=False, do_handshake_on_connect=True,
                   suppress_ragged_eofs=True, server_hostname=None, session=None):
    if not server_side:
        host = (server_hostname or '').lower().strip('[]')
        port = sock.getpeername()[1]
        expected = [pin for pin in _pins if pin['hostname'] == host and pin['port'] == port]
        if expected:
            context = ssl.SSLContext(self.protocol)
            context.options = self.options
            context.minimum_version = self.minimum_version
            context.maximum_version = self.maximum_version
            context.verify_flags = self.verify_flags
            context.set_ciphers(':'.join(cipher['name'] for cipher in self.get_ciphers()))
            context.load_verify_locations(cadata=''.join(pin['pem'] for pin in expected))
            self = context
            session = None
        self.verify_mode = ssl.CERT_REQUIRED
        self.check_hostname = True
        if expected:
            self.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        else:
            self.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    return _wrap_socket(self, sock, server_side=server_side,
        do_handshake_on_connect=do_handshake_on_connect,
        suppress_ragged_eofs=suppress_ragged_eofs, server_hostname=server_hostname, session=session)

def _verified_handshake(self, *args, **kwargs):
    if self.server_side:
        return _handshake(self, *args, **kwargs)
    host = (self.server_hostname or '').lower().strip('[]')
    peer = self.getpeername()
    expected = [pin for pin in _pins if pin['hostname'] == host and pin['port'] == peer[1]]
    try:
        result = _handshake(self, *args, **kwargs)
    except ssl.SSLCertVerificationError as error:
        failure = _certificate_failure(expected, peer[:2], host, error)
        self.close()
        raise failure from None
    failure = _certificate_failure(expected, peer[:2], host, certificate=self.getpeercert(binary_form=True))
    if failure:
        self.close()
        raise failure
    return result

ssl.SSLContext.wrap_socket = _verified_wrap
ssl.SSLSocket.do_handshake = _verified_handshake
`
