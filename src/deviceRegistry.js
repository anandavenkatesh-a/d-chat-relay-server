/**
 * deviceRegistry.js
 * Persists registered devices to the durable volume so registration
 * survives container restarts.
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
    // fine — may already exist
  }

  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    registry = new Map(Object.entries(JSON.parse(raw)));
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
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(registry), null, 2), 'utf8');
  } catch (err) {
    console.error('[Registry] Failed to persist registry:', err.message);
  }
}

function isRegistered(deviceId) {
  return registry.has(deviceId);
}

function register(deviceId, { signingPublicKey, encryptionPublicKey }) {
  registry.set(deviceId, { signingPublicKey, encryptionPublicKey, registeredAt: Date.now() });
  persist();
}

function registrySize() {
  return registry.size;
}

module.exports = { load, isRegistered, register, registrySize, REGISTRY_DIR, REGISTRY_FILE };
