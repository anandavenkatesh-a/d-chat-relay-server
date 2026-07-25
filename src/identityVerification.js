/**
 * identityVerification.js
 * Shared logic for verifying an identity claim — used by BOTH the
 * registration flow and the normal connect flow.
 *
 * device_id = SHA256(signing_public_key)
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');

function computeDeviceId(signingPublicKeyB64) {
  return crypto.createHash('sha256').update(signingPublicKeyB64).digest('base64url');
}

function verifyIdentityClaim({ deviceId, signingPublicKey, nonce, signature }) {
  if (!deviceId || !signingPublicKey || !nonce || !signature) return false;

  const expectedDeviceId = computeDeviceId(signingPublicKey);
  if (expectedDeviceId !== deviceId) return false;

  try {
    const pubKeyBytes = Buffer.from(signingPublicKey, 'base64');
    const nonceBytes = Buffer.from(nonce, 'base64');
    const sigBytes = Buffer.from(signature, 'base64');
    return nacl.sign.detached.verify(nonceBytes, sigBytes, pubKeyBytes);
  } catch {
    return false;
  }
}

module.exports = { computeDeviceId, verifyIdentityClaim };
