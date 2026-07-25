/**
 * server.js
 * SecureChat Relay Server
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
  const nonce = nonceStore.issue(ws);
  ws.send(JSON.stringify({ type: 'challenge', nonce }));

  ws.on('message', (raw) => {
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
        onPuzzleResponse(ws);
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
  });

  ws.on('close', () => {
    nonceStore.clear(ws);
    onRegisterDisconnect(ws);
    if (ws.deviceId) connections.unregister(ws.deviceId);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${ws.deviceId || 'unregistered'}:`, err.message);
    nonceStore.clear(ws);
    onRegisterDisconnect(ws);
    if (ws.deviceId) connections.unregister(ws.deviceId);
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err.message);
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
