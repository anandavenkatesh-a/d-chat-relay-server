/**
 * ackQueue.js
 * Stores pending ACKs (sent/stored/seen) for offline senders.
 * ACKs contain ONLY msg_id + status — zero message content.
 * Auto-expires after ACK_TTL_HOURS (default 24hrs).
 */

const ACK_TTL_MS = (parseInt(process.env.ACK_TTL_HOURS) || 24) * 60 * 60 * 1000;

// Map of device_id → [ { msgId, status, expiresAt } ]
const queue = new Map();

function push(forDeviceId, msgId, status) {
  if (!queue.has(forDeviceId)) {
    queue.set(forDeviceId, []);
  }
  queue.get(forDeviceId).push({
    msgId,
    status,
    expiresAt: Date.now() + ACK_TTL_MS,
  });
}

/**
 * Returns all pending ACKs for a device and clears them immediately.
 * Called when device reconnects and sends pull_acks.
 */
function flush(forDeviceId) {
  const acks = queue.get(forDeviceId) || [];
  queue.delete(forDeviceId);
  return acks.map(({ msgId, status }) => ({ msgId, status }));
}

/**
 * TTL cleanup — removes expired ACKs across all devices.
 * Called periodically by the cleanup job in server.js.
 */
function purgeExpired() {
  const now = Date.now();
  let purged = 0;

  for (const [deviceId, acks] of queue.entries()) {
    const fresh = acks.filter((a) => a.expiresAt > now);
    purged += acks.length - fresh.length;
    if (fresh.length === 0) {
      queue.delete(deviceId);
    } else {
      queue.set(deviceId, fresh);
    }
  }

  if (purged > 0) {
    console.log(`[ACK] Purged ${purged} expired ACK(s)`);
  }
}

function queueSize() {
  let total = 0;
  for (const acks of queue.values()) total += acks.length;
  return total;
}

module.exports = { push, flush, purgeExpired, queueSize };
