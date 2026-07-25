/**
 * nonceStore.js
 * Tracks challenge nonces issued to connecting clients, so each one
 * can only be used once (replay protection) and expires quickly if
 * never used.
 */

const NONCE_TTL_MS = 30_000;

const pending = new Map();

function issue(ws) {
  const nonce = require('crypto').randomBytes(32).toString('base64');
  pending.set(ws, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  return nonce;
}

function consume(ws, providedNonce) {
  const entry = pending.get(ws);
  pending.delete(ws);

  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.nonce === providedNonce;
}

function clear(ws) {
  pending.delete(ws);
}

module.exports = { issue, consume, clear };
