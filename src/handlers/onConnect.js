/**
 * onConnect.js
 * Registers device_id → WebSocket when a device announces itself.
 * Immediately flushes any messages that were queued while this
 * device was offline (up to 24h old, still opaque ciphertext).
 *
 * Expected event:
 *   { type: "connect", device_id: "sha256hash" }
 *
 * Responses:
 *   { type: "connected", device_id }
 *   { type: "message", from, msg_id, payload }  ← one per queued message, in order
 */

const connections = require('../connections');
const messageQueue = require('../messageQueue');

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

  // Deliver anything that was queued while this device was offline
  const pending = messageQueue.flush(device_id);
  if (pending.length > 0) {
    console.log(`[↓] Flushing ${pending.length} queued message(s) to ${device_id}`);
    for (const { msgId, from, ciphertext } of pending) {
      ws.send(JSON.stringify({
        type: 'message',
        from,
        msg_id: msgId,
        payload: ciphertext,
      }));
    }
  }
}

module.exports = onConnect;
