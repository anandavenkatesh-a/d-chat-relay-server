/**
 * server.js
 * SecureChat Relay Server
 *
 * ⚠️ CRITICAL FIX, from a real production incident: a previous
 * version of this file called `onPuzzleResponse(ws)` with no second
 * argument, from before the puzzle protocol carried an answer at all.
 * onRegister.js was updated to expect `onPuzzleResponse(ws, data)` and
 * read `data.count` — but this file was never updated to match, so
 * `data` was always `undefined` here, and every single puzzle
 * submission threw an uncaught TypeError that crashed the ENTIRE
 * process. Since this relay accepts connections from anonymous,
 * unauthenticated Tor clients specifically as an anti-abuse system, an
 * uncaught exception from ANY single message was effectively a
 * trivial one-message denial-of-service against every other connected
 * user — the crash doesn't just fail that one request, it takes the
 * whole relay down (and Tor has to fully re-bootstrap on restart,
 * meaning real multi-minute outages for everyone from one bad or
 * malicious message). Both problems are fixed here: the actual
 * routing bug, and — as defense in depth against this ever happening
 * again in any form — the entire per-message handling path is now
 * wrapped in try/catch, so a thrown error inside any handler logs and
 * drops that one message instead of crashing the process.
 */

require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const connections = require('./connections');
const ackQueue = require('./ackQueue');
const messageQueue = require('./messageQueue');
const nonceStore = require('./nonceStore');
const rateLimiter = require('./rateLimiter');
const deviceRegistry = require('./deviceRegistry');
const puzzles = require('./puzzles');

const onConnect   = require('./handlers/onConnect');
const onSend      = require('./handlers/onSend');
const onAck       = require('./handlers/onAck');
const onPullAcks  = require('./handlers/onPullAcks');
const { onRegisterRequest, onPuzzleResponse, onDisconnect: onRegisterDisconnect } = require('./handlers/onRegister');

const PORT = parseInt(process.env.PORT) || 8080;
const CLEANUP_INTERVAL_MS = (parseInt(process.env.CLEANUP_INTERVAL_MINUTES) || 60) * 60 * 1000;

deviceRegistry.load();

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      connections: wss ? wss.clients.size : 0,
      ackQueueSize: ackQueue.queueSize(),
      messageQueueSize: messageQueue.queueSize(),
      registeredDevices: deviceRegistry.registrySize(),
      uptime: Math.floor(process.uptime()),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`\n🚀 SecureChat Relay running on port ${PORT}`);
  console.log(`   Health check      : http://localhost:${PORT}/health`);
  console.log(`   ACK TTL           : ${process.env.ACK_TTL_HOURS || 24} hours`);
  console.log(`   Message TTL       : ${process.env.MESSAGE_TTL_HOURS || 24} hours`);
  console.log(`   Max queued/dev    : ${messageQueue.MAX_QUEUED_PER_DEVICE}`);
  console.log(`   Registered devices: ${deviceRegistry.registrySize()}`);
  console.log(`   Cleanup every     : ${process.env.CLEANUP_INTERVAL_MINUTES || 60} minutes\n`);
});

wss.on('connection', (ws, req) => {
  // Deliberately NOT logging req.socket.remoteAddress or any IP.

  const nonce = nonceStore.issue(ws);
  ws.send(JSON.stringify({ type: 'challenge', nonce }));

  ws.on('message', (raw) => {
    // Everything below is wrapped — see file header. A thrown error
    // anywhere in here now logs and drops this one message, instead
    // of crashing the entire process for every connected user.
    try {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (!data.type) {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing event type' }));
        return;
      }

      switch (data.type) {
        case 'register_request':
          onRegisterRequest(ws, data);
          break;

        case 'puzzle_response':
          // THE FIX: `data` must be passed through — onRegister.js
          // reads data.count from it. Omitting it (as a previous
          // version of this file did) is exactly what caused the
          // production crash this comment block describes.
          onPuzzleResponse(ws, data);
          break;

        case 'connect':
          onConnect(ws, data);
          break;

        case 'send':
          onSend(ws, data);
          break;

        case 'ack_stored':
        case 'ack_seen':
          onAck(ws, data);
          break;

        case 'pull_acks':
          onPullAcks(ws, data);
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown event type: ${data.type}` }));
      }
    } catch (err) {
      // Defense in depth — see file header. Never let a handler's
      // thrown error escape and crash the process.
      console.error('[WS] Unhandled error while processing message:', err.message);
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Internal error processing your request' }));
      } catch {
        // socket may already be closed — nothing more to do
      }
    }
  });

  ws.on('close', () => {
    nonceStore.clear(ws);
    onRegisterDisconnect(ws);
    if (ws.deviceId) {
      connections.unregister(ws.deviceId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${ws.deviceId || 'unregistered'}:`, err.message);
    nonceStore.clear(ws);
    onRegisterDisconnect(ws);
    if (ws.deviceId) {
      connections.unregister(ws.deviceId);
    }
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err.message);
});

// ── Process-level safety net ──────────────────────────────────────────────────
// This is deliberately DIFFERENT from the per-message try/catch above.
// The per-message catch is safe to swallow-and-continue from, because
// the failure is scoped to processing one specific message — nothing
// about the process's own state is in question. An uncaughtException
// or unhandledRejection reaching THIS point means something failed
// outside that bounded scope, where the process's internal state is
// no longer trustworthy — Node's own guidance is explicit that you
// should not attempt to resume normal operation after one of these,
// since doing so risks silently accumulating corruption (leaked
// resources, a socket server in a bad state, etc.) that surfaces as
// much harder-to-diagnose problems later. So this logs with full
// detail (unlike the original incident, where the crash dump alone
// didn't make the actual cause obvious) and then exits — letting
// Railway's restart policy bring up a fresh, known-good process,
// exactly as it already does today, just with much better logging
// for whatever caused it next time.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception — exiting for a clean restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection — exiting for a clean restart:', reason);
  process.exit(1);
});

setInterval(() => {
  ackQueue.purgeExpired();
  messageQueue.purgeExpired();
  rateLimiter.purgeIdle();
  console.log(
    `[CLEANUP] ACK queue: ${ackQueue.queueSize()} | Message queue: ${messageQueue.queueSize()} | ` +
    `Active connections: ${wss.clients.size} | Registered devices: ${deviceRegistry.registrySize()}`
  );
}, CLEANUP_INTERVAL_MS);

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down relay...`);
  wss.close(() => {
    httpServer.close(() => {
      console.log('[BYE] All connections closed.');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
