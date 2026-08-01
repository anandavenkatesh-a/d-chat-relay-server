/**
 * onRegister.js
 * Handles the registration flow: identity proof (signature over a
 * server nonce) + the single streamed audio-discrimination puzzle.
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

  console.log(`[Register] Starting continuous noise-masked audio puzzle for new device_id: ${device_id}`);

  puzzles.startSession(ws, {
    onSessionStart: (total) => {
      send(ws, {
        type: 'puzzle_session_start',
        total_chunks: total,
        chunk_duration_ms: puzzles.CHUNK_DURATION_MS,
        session_duration_ms: puzzles.SESSION_DURATION_MS,
      });
    },
    onChunk: (chunk) => {
      send(ws, {
        type: 'puzzle_audio_chunk',
        index: chunk.index,
        total: chunk.total,
        audio_base64: chunk.audioBase64,
        is_final: chunk.isFinal,
      });
    },
    onAnswerWindowOpen: (windowMs) => {
      send(ws, { type: 'puzzle_answer_window', deadline_ms: windowMs });
    },
  });
}

function onPuzzleResponse(ws, data) {
  const context = ws._pendingRegistration;
  if (!context) return;

  const result = puzzles.submitResponse(ws, data.count);

  if (!result.pass) {
    delete ws._pendingRegistration;
    send(ws, { type: 'register_ack', success: false, reason: 'puzzle_failed' });
    return;
  }

  deviceRegistry.register(context.deviceId, {
    signingPublicKey: context.signingPublicKey,
    encryptionPublicKey: context.encryptionPublicKey,
  });
  console.log(`[Register] Success — device_id registered: ${context.deviceId}`);
  delete ws._pendingRegistration;
  send(ws, { type: 'register_ack', success: true });
}

function onDisconnect(ws) {
  delete ws._pendingRegistration;
  puzzles.clearSession(ws);
}

module.exports = { onRegisterRequest, onPuzzleResponse, onDisconnect };
