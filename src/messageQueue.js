/**
 * messageQueue.js
 * Stores pending encrypted message blobs for OFFLINE recipients.
 * Auto-expires after MESSAGE_TTL_HOURS (default 24hrs).
 *
 * PRIVACY: the relay never reads `ciphertext` — it is opaque to this
 * server just like when forwarding live. This queue only changes WHEN
 * a blob is delivered (on reconnect instead of immediately), never WHAT
 * the relay can see.
 *
 * Kept in-memory only, never written to disk. A server restart clears
 * all queued messages — this is intentional: it means Railway (or
 * whoever hosts this) can never hand over queued ciphertext that no
 * longer exists in memory after a restart.
 */

const MESSAGE_TTL_MS = (parseInt(process.env.MESSAGE_TTL_HOURS) || 24) * 60 * 60 * 1000;

// Hard cap per recipient to prevent memory exhaustion from a single
// device being offline for a long time and receiving unbounded messages.
const MAX_QUEUED_PER_DEVICE = parseInt(process.env.MAX_QUEUED_PER_DEVICE) || 500;

// Map of device_id → [ { msgId, from, ciphertext, expiresAt } ]
const queue = new Map();

/**
 * Queue a message for a currently-offline recipient.
 * If the recipient's queue is already at MAX_QUEUED_PER_DEVICE,
 * the OLDEST message is dropped to make room (FIFO eviction).
 */
function push(toDeviceId, msgId, fromDeviceId, ciphertext) {
  if (!queue.has(toDeviceId)) {
    queue.set(toDeviceId, []);
  }

  const bucket = queue.get(toDeviceId);

  if (bucket.length >= MAX_QUEUED_PER_DEVICE) {
    bucket.shift(); // drop oldest
  }

  const now = Date.now();
  bucket.push({
    msgId,
    from: fromDeviceId,
    ciphertext,
    // The relay's OWN receive time, not anything the sender claims —
    // this is what gets shown to the recipient as the message
    // timestamp (see onConnect.js / onSend.js), instead of whatever
    // moment the recipient's device happens to download and process
    // it. For a message queued while the recipient was offline, that
    // gap could be minutes to the full 24h TTL — using the relay's
    // receive time (very close to the sender's actual send moment,
    // modulo network latency) is a far better, and cross-device-
    // clock-skew-free, proxy for "when was this actually sent" than
    // either the recipient's download time or trusting the sender's
    // own device clock.
    sentAt: now,
    expiresAt: now + MESSAGE_TTL_MS,
  });
}

/**
 * Returns all pending messages for a device, in FIFO order, and
 * clears them immediately. Called when a device reconnects.
 */
function flush(toDeviceId) {
  const messages = queue.get(toDeviceId) || [];
  queue.delete(toDeviceId);
  return messages
    .filter((m) => m.expiresAt > Date.now()) // drop any that expired mid-flight
    .map(({ msgId, from, ciphertext, sentAt }) => ({ msgId, from, ciphertext, sentAt }));
}

/**
 * TTL cleanup — removes expired messages across all devices.
 * Called periodically by the cleanup job in server.js.
 */
function purgeExpired() {
  const now = Date.now();
  let purged = 0;

  for (const [deviceId, messages] of queue.entries()) {
    const fresh = messages.filter((m) => m.expiresAt > now);
    purged += messages.length - fresh.length;
    if (fresh.length === 0) {
      queue.delete(deviceId);
    } else {
      queue.set(deviceId, fresh);
    }
  }

  if (purged > 0) {
    console.log(`[MSGQ] Purged ${purged} expired queued message(s)`);
  }
}

function queueSize() {
  let total = 0;
  for (const messages of queue.values()) total += messages.length;
  return total;
}

module.exports = { push, flush, purgeExpired, queueSize, MAX_QUEUED_PER_DEVICE };
