/**
 * onRegister.js
 * Handles the registration flow (Functionality 1 + the ownership
 * proof folded in from Functionality 2, to prevent device_id
 * squatting).
 */

const nonceStore = require('../nonceStore');
const puzzles = require('../puzzles');
const deviceRegistry = require('../deviceRegistry');
const { verifyIdentityClaim } = require('../identityVerification');

function send(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket already closed
  }
}

function onRegisterRequest(ws, data) {
  const { device_id, signing_public_key, encryption_public_key, nonce, signature } = data;

  const validClaim = verifyIdentityClaim({
    deviceId: device_id,
    signingPublicKey: signing_public_key,
    nonce,
    signature,
  });

  if (!validClaim) {
    send(ws, { type: 'register_ack', success: false, reason: 'invalid_identity_proof' });
    return;
  }

  const nonceValid = nonceStore.consume(ws, nonce);
  if (!nonceValid) {
    send(ws, { type: 'register_ack', success: false, reason: 'invalid_or_expired_nonce' });
    return;
  }

  if (deviceRegistry.isRegistered(device_id)) {
    send(ws, { type: 'register_ack', success: true, already_registered: true });
    return;
  }

  ws._pendingRegistration = {
    deviceId: device_id,
    signingPublicKey: signing_public_key,
    encryptionPublicKey: encryption_public_key,
  };

  console.log(`[Register] Starting puzzle gauntlet for new device_id: ${device_id}`);

  puzzles.startSession(ws);
  puzzles.beginRound(ws, (round, total) => {
    send(ws, { type: 'puzzle_reveal', round, total });
  });
}

function onPuzzleResponse(ws) {
  const context = ws._pendingRegistration;
  if (!context) return;

  const result = puzzles.submitResponse(ws);

  if (!result.pass) {
    delete ws._pendingRegistration;
    send(ws, { type: 'register_ack', success: false, reason: 'puzzle_failed' });
    return;
  }

  if (result.done) {
    deviceRegistry.register(context.deviceId, {
      signingPublicKey: context.signingPublicKey,
      encryptionPublicKey: context.encryptionPublicKey,
    });
    console.log(`[Register] Success — device_id registered: ${context.deviceId}`);
    delete ws._pendingRegistration;
    send(ws, { type: 'register_ack', success: true });
    return;
  }

  puzzles.beginRound(ws, (round, total) => {
    send(ws, { type: 'puzzle_reveal', round, total });
  });
}

function onDisconnect(ws) {
  delete ws._pendingRegistration;
  puzzles.clearSession(ws);
}

module.exports = { onRegisterRequest, onPuzzleResponse, onDisconnect };
