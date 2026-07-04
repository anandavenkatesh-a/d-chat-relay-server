/**
 * server.js
 * SecureChat Relay Server
 *
 * Responsibilities:
 *  - Accept WebSocket connections from devices
 *  - Route encrypted message blobs (never reads payload)
 *  - Queue ACKs (stored/seen) for offline senders, flush on reconnect
 *  - Purge expired ACKs every CLEANUP_INTERVAL_MINUTES
 *
 * What this server will NEVER do:
 *  - Store message content
 *  - Read or decrypt any payload
 *  - Know usernames or identities (only opaque device_ids)
 */

require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const connections = require('./connections');
const ackQueue = require('./ackQueue');
const messageQueue = require('./messageQueue');

const onConnect   = require('./handlers/onConnect');
const onSend      = require('./handlers/onSend');
const onAck       = require('./handlers/onAck');
const onPullAcks  = require('./handlers/onPullAcks');

const PORT = parseInt(process.env.PORT) || 8080;
const CLEANUP_INTERVAL_MS = (parseInt(process.env.CLEANUP_INTERVAL_MINUTES) || 60) * 60 * 1000;

// ── HTTP Server (health endpoint only) ───────────────────────────────────────
// Shares the same port as the WebSocket server.
// Railway (and any load balancer) hits GET /health to verify the process is up.

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      connections: wss ? wss.clients.size : 0,
      ackQueueSize: ackQueue.queueSize(),
      messageQueueSize: messageQueue.queueSize(),
      uptime: Math.floor(process.uptime()),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── WebSocket Server (attached to the same HTTP server) ──────────────────────

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`\n🚀 SecureChat Relay running on port ${PORT}`);
  console.log(`   Health check  : http://localhost:${PORT}/health`);
  console.log(`   ACK TTL       : ${process.env.ACK_TTL_HOURS || 24} hours`);
  console.log(`   Message TTL   : ${process.env.MESSAGE_TTL_HOURS || 24} hours`);
  console.log(`   Max queued/dev: ${messageQueue.MAX_QUEUED_PER_DEVICE}`);
  console.log(`   Cleanup every : ${process.env.CLEANUP_INTERVAL_MINUTES || 60} minutes\n`);
});

wss.on('connection', (ws, req) => {
  // Deliberately NOT logging req.socket.remoteAddress or any IP —
  // the relay must never persist or print information that could
  // link a device_id to a real-world network identity, even in logs.

  ws.on('message', (raw) => {
    let data;

    // Parse JSON — drop malformed messages silently
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

    // Route to the correct handler
    switch (data.type) {
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
  });

  ws.on('close', () => {
    if (ws.deviceId) {
      connections.unregister(ws.deviceId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${ws.deviceId || 'unregistered'}:`, err.message);
    if (ws.deviceId) {
      connections.unregister(ws.deviceId);
    }
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err.message);
});

// ── ACK Cleanup Job ───────────────────────────────────────────────────────────

setInterval(() => {
  ackQueue.purgeExpired();
  messageQueue.purgeExpired();
  console.log(`[CLEANUP] ACK queue: ${ackQueue.queueSize()} | Message queue: ${messageQueue.queueSize()} | Active connections: ${wss.clients.size}`);
}, CLEANUP_INTERVAL_MS);

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

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
