/**
 * onConnect.js
 * Registers device_id → WebSocket when a device announces itself.
 *
 * Expected event:
 *   { type: "connect", device_id: "sha256hash" }
 *
 * Response:
 *   { type: "connected", device_id }
 */

const connections = require('../connections');

function onConnect(ws, data) {
  const { device_id } = data;

  if (!device_id || typeof device_id !== 'string' || device_id.length < 8) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid device_id' }));
    return;
  }

  // Tag the socket with its device_id for cleanup on disconnect
  ws.deviceId = device_id;

  connections.register(device_id, ws);
  ws.send(JSON.stringify({ type: 'connected', device_id }));
}

module.exports = onConnect;
