/**
 * onPullAcks.js
 * Called by a device immediately after reconnecting.
 * Flushes all queued ACKs for that device and deletes them.
 *
 * Expected event:
 *   { type: "pull_acks", device_id: "sha256hash" }
 *
 * Response:
 *   { type: "pending_acks", acks: [ { msgId, status }, ... ] }
 *   (empty array if nothing queued)
 */

const ackQueue = require('../ackQueue');

function onPullAcks(ws, data) {
  const deviceId = ws.deviceId;

  if (!deviceId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not registered. Send connect first.' }));
    return;
  }

  const acks = ackQueue.flush(deviceId);

  ws.send(JSON.stringify({ type: 'pending_acks', acks }));

  if (acks.length > 0) {
    console.log(`[↓] Flushed ${acks.length} ACK(s) to ${deviceId}`);
  }
}

module.exports = onPullAcks;
