/**
 * onSend.js
 * Routes an encrypted message blob from sender to recipient.
 * The relay NEVER reads the payload — it's opaque ciphertext.
 *
 * Expected event:
 *   { type: "send", to: "device_id", msg_id: "uuid", payload: "base64ciphertext" }
 *
 * Responses to sender:
 *   { type: "ack_sent",   msg_id }  ← relay received it
 *   { type: "ack_queued", msg_id }  ← recipient offline, message queued (up to 24h)
 *
 * Event forwarded to recipient (live or on reconnect):
 *   { type: "message", from: "device_id", msg_id, payload }
 */

const connections = require('../connections');
const messageQueue = require('../messageQueue');
const rateLimiter = require('../rateLimiter');

function onSend(ws, data) {
  const { to, msg_id, payload } = data;
  const from = ws.deviceId;

  // Validate
  if (!from) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not registered. Send connect first.' }));
    return;
  }
  if (!to || !msg_id || !payload) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing to / msg_id / payload' }));
    return;
  }

  if (!rateLimiter.allow(from)) {
    ws.send(JSON.stringify({ type: 'rate_limited', retry_after: 1 }));
    return;
  }

  // ACK sender immediately — relay has received the message
  ws.send(JSON.stringify({ type: 'ack_sent', msg_id }));

  // Relay's own receive time — used as the message timestamp on the
  // recipient's side (see messageQueue.js's push() comment for why),
  // consistently for both live and queued delivery.
  const sentAt = Date.now();

  // Try live delivery first
  const delivered = connections.send(to, {
    type: 'message',
    from,
    msg_id,
    payload, // opaque ciphertext, relay never reads this
    sent_at: sentAt,
  });

  if (!delivered) {
    // Recipient is offline — queue the ciphertext blob (24h TTL, still opaque)
    messageQueue.push(to, msg_id, from, payload);
    ws.send(JSON.stringify({ type: 'ack_queued', msg_id }));
    console.log(`[~] Message ${msg_id} queued — ${to} is offline`);
  } else {
    console.log(`[→] Message ${msg_id} routed live: ${from} → ${to}`);
  }
}

module.exports = onSend;
