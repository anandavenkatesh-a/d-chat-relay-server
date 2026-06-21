/**
 * onAck.js
 * Handles ack_stored and ack_seen events from the recipient.
 * Pipes them back to the original sender, or queues if sender is offline.
 *
 * Expected events:
 *   { type: "ack_stored", msg_id, to: "sender_device_id" }
 *   { type: "ack_seen",   msg_id, to: "sender_device_id" }
 *
 * The recipient must include `to` (the original sender's device_id)
 * so the relay knows where to route the ACK back.
 */

const connections = require('../connections');
const ackQueue = require('../ackQueue');

function onAck(ws, data) {
  const { type, msg_id, to } = data;
  const status = type === 'ack_stored' ? 'stored' : 'seen';

  if (!msg_id || !to) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing msg_id or to in ACK' }));
    return;
  }

  // Try to deliver ACK directly if sender is online
  const delivered = connections.send(to, { type, msg_id });

  if (!delivered) {
    // Sender is offline — queue the ACK for pull on reconnect
    ackQueue.push(to, msg_id, status);
    console.log(`[Q] ACK queued: ${status} for msg ${msg_id} → ${to}`);
  } else {
    console.log(`[✓] ACK delivered: ${status} for msg ${msg_id} → ${to}`);
  }
}

module.exports = onAck;
