/**
 * puzzles.js
 * "Next-gen" human-verification puzzle used during registration.
 *
 * Design: a reaction-timing challenge where the SERVER — not the
 * client — measures elapsed time using its own clock across a real
 * network round trip. A client that merely self-reports "I reacted in
 * 220ms" cannot be trusted at all — but a client that must genuinely
 * wait for an unpredictable, server-chosen reveal moment, then
 * respond, has its timing measured entirely by events the server
 * itself sent and received.
 *
 * Protocol, per round:
 *   1. Server picks a random delay (never sent to the client)
 *   2. After that delay, server sends `puzzle_reveal` and records its
 *      own send timestamp
 *   3. Client shows a visual cue immediately, sends `puzzle_response`
 *      the instant the user taps
 *   4. Server measures elapsed time between ITS send and ITS receive
 *
 * ⚠️ Honest limitation specific to this deployment: because all
 * traffic is routed through Tor, network latency is both higher and
 * far more variable than on a typical clearnet connection. This
 * compresses the useful discrimination window between "plausible
 * human reaction + network latency" and "scripted instant response +
 * network latency". This puzzle should be understood as ONE layer
 * (raising the cost of automating registration — a script must
 * correctly implement this exact bidirectional protocol, not just
 * fire a single HTTP-style request) rather than a complete, standalone
 * solution. See README.md's vulnerabilities section.
 */

const ROUNDS_REQUIRED = 3;
const MIN_REVEAL_DELAY_MS = 1000;
const MAX_REVEAL_DELAY_MS = 4000;
const MIN_REACTION_MS = 80;
const MAX_REACTION_MS = 5000;
const MIN_VARIANCE_MS = 15;

const sessions = new Map();

function startSession(ws) {
  sessions.set(ws, { round: 0, roundResults: [], revealSentAt: null, timer: null });
}

function clearSession(ws) {
  const session = sessions.get(ws);
  if (session?.timer) clearTimeout(session.timer);
  sessions.delete(ws);
}

function beginRound(ws, onReveal) {
  const session = sessions.get(ws);
  if (!session) return;

  session.round += 1;
  const delay = MIN_REVEAL_DELAY_MS + Math.random() * (MAX_REVEAL_DELAY_MS - MIN_REVEAL_DELAY_MS);

  session.timer = setTimeout(() => {
    session.revealSentAt = Date.now();
    onReveal(session.round, ROUNDS_REQUIRED);
  }, delay);
}

function submitResponse(ws) {
  const session = sessions.get(ws);
  if (!session || session.revealSentAt === null) {
    return { pass: false, done: true, roundsCompleted: 0 };
  }

  const elapsed = Date.now() - session.revealSentAt;
  session.revealSentAt = null;

  const withinBounds = elapsed >= MIN_REACTION_MS && elapsed <= MAX_REACTION_MS;

  if (!withinBounds) {
    clearSession(ws);
    return { pass: false, done: true, roundsCompleted: session.round - 1 };
  }

  session.roundResults.push(elapsed);

  if (session.round >= ROUNDS_REQUIRED) {
    const results = session.roundResults;
    const mean = results.reduce((a, b) => a + b, 0) / results.length;
    const maxDeviation = Math.max(...results.map((r) => Math.abs(r - mean)));

    const suspiciouslyConsistent = maxDeviation < MIN_VARIANCE_MS;
    clearSession(ws);

    return {
      pass: !suspiciouslyConsistent,
      done: true,
      roundsCompleted: ROUNDS_REQUIRED,
    };
  }

  return { pass: true, done: false, roundsCompleted: session.round };
}

module.exports = {
  ROUNDS_REQUIRED,
  startSession,
  clearSession,
  beginRound,
  submitResponse,
};
