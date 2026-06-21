/**
 * onSend.js
 * Routes an encrypted message blob from sender to recipient.
 * The relay NEVER reads the payload — it's opaque ciphertext.
 *
 * Expected event:
 *   { type: "send", to: "device_id", msg_id: "uuid", payload: "base64ciphertext" }
 *
 * Responses to sender:
 *   { type: "ack_sent",  msg_id }  ← relay received it
 *   { type: "dropped",   msg_id }  ← recipient offline, message dropped
 *
 * Event forwarded to recipient:
 *   { type: "message", from: "device_id", msg_id, payload }
 */

const connections = require('../connections');

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

  // ACK sender immediately — relay has received the message
  ws.send(JSON.stringify({ type: 'ack_sent', msg_id }));

  // Forward to recipient
  const delivered = connections.send(to, {
    type: 'message',
    from,
    msg_id,
    payload, // opaque ciphertext, relay never reads this
  });

  if (!delivered) {
    // Recipient is offline — drop message, notify sender
    ws.send(JSON.stringify({ type: 'dropped', msg_id }));
    console.log(`[~] Message ${msg_id} dropped — ${to} is offline`);
  } else {
    console.log(`[→] Message ${msg_id} routed: ${from} → ${to}`);
  }
}

module.exports = onSend;
