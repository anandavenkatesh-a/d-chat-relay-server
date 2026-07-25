/**
 * onConnect.js
 * Handles a `connect` message from an ALREADY-REGISTERED device
 * reconnecting for normal use (Functionality 2).
 */

const connections = require('../connections');
const messageQueue = require('../messageQueue');
const nonceStore = require('../nonceStore');
const deviceRegistry = require('../deviceRegistry');
const rateLimiter = require('../rateLimiter');
const { verifyIdentityClaim } = require('../identityVerification');

function send(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // already closed
  }
}

function onConnect(ws, data) {
  const { device_id, signing_public_key, nonce, signature } = data;

  const validClaim = verifyIdentityClaim({
    deviceId: device_id,
    signingPublicKey: signing_public_key,
    nonce,
    signature,
  });

  if (!validClaim) {
    send(ws, { type: 'error', reason: 'invalid_identity_proof' });
    ws.close();
    return;
  }

  const nonceValid = nonceStore.consume(ws, nonce);
  if (!nonceValid) {
    send(ws, { type: 'error', reason: 'invalid_or_expired_nonce' });
    ws.close();
    return;
  }

  if (!deviceRegistry.isRegistered(device_id)) {
    send(ws, { type: 'error', reason: 'not_registered' });
    ws.close();
    return;
  }

  if (!rateLimiter.allow(device_id)) {
    send(ws, { type: 'rate_limited', retry_after: 1 });
    ws.close();
    return;
  }

  ws.deviceId = device_id;
  connections.register(device_id, ws);
  send(ws, { type: 'connected', device_id });

  const pending = messageQueue.flush(device_id);
  if (pending.length > 0) {
    console.log(`[↓] Flushing ${pending.length} queued message(s) to ${device_id}`);
    for (const { msgId, from, ciphertext, sentAt } of pending) {
      send(ws, { type: 'message', from, msg_id: msgId, payload: ciphertext, sent_at: sentAt });
    }
  }
}

module.exports = onConnect;
