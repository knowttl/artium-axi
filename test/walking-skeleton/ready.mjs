import { Server } from 'node:net'

// The real entry point has no startup logs. Observe listening without changing its configuration.
const emit = Server.prototype.emit
Server.prototype.emit = function (event, ...args) {
  if (event === 'listening') console.log('artium-test-ready')
  return emit.call(this, event, ...args)
}
