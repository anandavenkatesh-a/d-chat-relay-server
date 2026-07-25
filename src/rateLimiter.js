/**
 * rateLimiter.js
 * Token-bucket rate limiting per device_id. Only meaningful AFTER a
 * device_id has been verified (ownership signature checked).
 */

const BUCKET_CAPACITY = 20;
const REFILL_PER_SECOND = 2;

const buckets = new Map();

function _getBucket(deviceId) {
  let bucket = buckets.get(deviceId);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefill: Date.now() };
    buckets.set(deviceId, bucket);
  }
  return bucket;
}

function _refill(bucket) {
  const now = Date.now();
  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND);
  bucket.lastRefill = now;
}

function allow(deviceId) {
  const bucket = _getBucket(deviceId);
  _refill(bucket);

  if (bucket.tokens < 1) return false;

  bucket.tokens -= 1;
  return true;
}

function purgeIdle() {
  const now = Date.now();
  let purged = 0;
  for (const [deviceId, bucket] of buckets.entries()) {
    const idleSeconds = (now - bucket.lastRefill) / 1000;
    if (idleSeconds > 3600) {
      buckets.delete(deviceId);
      purged++;
    }
  }
  if (purged > 0) console.log(`[RateLimit] Purged ${purged} idle bucket(s)`);
}

module.exports = { allow, purgeIdle };
