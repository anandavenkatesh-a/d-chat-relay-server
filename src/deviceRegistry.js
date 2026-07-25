/**
 * deviceRegistry.js
 *
 * Persists registered devices — { device_id -> { signingPublicKey,
 * encryptionPublicKey, registeredAt } } — to the durable volume so
 * registration survives container restarts, unlike the relay's other
 * state (connections, ACK queue, message queue), which is deliberately
 * in-memory-only and fine to lose.
 *
 * A device is only ever written here after BOTH:
 *   1. Proving ownership of the claimed device_id (valid signature
 *      over a server-issued nonce — see nonceStore.js / onConnect.js)
 *   2. Passing all required next-gen puzzle rounds (see puzzles.js)
 *
 * Storage: a single JSON file, loaded into memory at startup and
 * rewritten on every successful registration. Registrations are
 * infrequent and rate-limited by design (puzzle solving takes real
 * time), so this simple approach is more than adequate — no database
 * dependency needed for this scale.
 */

const fs = require('fs');
const path = require('path');

const VOLUME_MOUNT_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const REGISTRY_DIR = path.join(VOLUME_MOUNT_PATH, 'registry');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'devices.json');

let registry = new Map();

function load() {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  } catch {
    // Directory may already exist / be created by docker-entrypoint.sh — fine.
  }

  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    registry = new Map(Object.entries(parsed));
    console.log(`[Registry] Loaded ${registry.size} registered device(s) from disk`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[Registry] No existing registry file — starting fresh');
    } else {
      console.error('[Registry] Failed to load registry, starting fresh:', err.message);
    }
    registry = new Map();
  }
}

function persist() {
  try {
    const obj = Object.fromEntries(registry);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[Registry] Failed to persist registry:', err.message);
  }
}

function isRegistered(deviceId) {
  return registry.has(deviceId);
}

function getEntry(deviceId) {
  return registry.get(deviceId) || null;
}

function register(deviceId, { signingPublicKey, encryptionPublicKey }) {
  registry.set(deviceId, {
    signingPublicKey,
    encryptionPublicKey,
    registeredAt: Date.now(),
  });
  persist();
}

function registrySize() {
  return registry.size;
}

module.exports = {
  load,
  isRegistered,
  getEntry,
  register,
  registrySize,
  REGISTRY_DIR,
  REGISTRY_FILE,
};
