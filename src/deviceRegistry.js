/**
 * deviceRegistry.js
 *
 * RESERVED FOR A FUTURE FEATURE — not used by anything yet.
 *
 * When device_id registration (the proof-of-ownership signature
 * handshake discussed for anti-Sybil defense) gets built, it will need
 * somewhere durable to persist { device_id -> public keys } across
 * restarts — unlike the relay's current connection/ACK/message state,
 * which is deliberately in-memory-only and fine to lose on restart.
 *
 * This file exists now purely so the storage layout is already in
 * place — no future volume/permission wiring needed, that's already
 * handled by docker-entrypoint.sh, which creates and chowns this exact
 * directory on every container start regardless of whether anything
 * uses it yet.
 *
 * Deliberately empty of actual logic — implement this when the
 * registration feature itself is built, not before.
 */

const path = require('path');

// Matches the directory docker-entrypoint.sh creates under the
// persistent volume. Falls back to a local path for development
// without a real volume attached.
const VOLUME_MOUNT_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const REGISTRY_DIR = path.join(VOLUME_MOUNT_PATH, 'registry');

module.exports = {
  REGISTRY_DIR,
};
