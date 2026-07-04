/**
 * test.js
 * Integration tests for the relay, including the new 24h message queue.
 * Run with: node test.js   (server must be running on RELAY url below)
 *
 * Tests covered:
 *  1. connect        — both devices register
 *  2. send (live)     — Alice sends to online Bob, delivered immediately
 *  3. ack_sent        — relay ACKs Alice immediately
 *  4. ack_stored/seen — status round trip
 *  5. send (queued)   — Alice sends to OFFLINE Bob → ack_queued, not dropped
 *  6. flush on connect — Bob reconnects, receives the queued message automatically
 *  7. FIFO order       — multiple queued messages arrive in the order sent
 *  8. pull_acks        — existing ACK queue still works alongside message queue
 */

const WebSocket = require('ws');

const RELAY = 'ws://localhost:9092';

const ALICE_ID = 'alice_device_sha256_aaaa';
const BOB_ID   = 'bob_device_sha256_bbbb';
const PAYLOAD  = 'BASE64_ENCRYPTED_CIPHERTEXT_OPAQUE_TO_RELAY';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log('  ✅', label); passed++; }
  else           { console.error('  ❌', label); failed++; }
}

function connect(deviceId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY);
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', device_id: deviceId })));
    setTimeout(() => resolve({ ws, messages }), 300);
  });
}

function waitFor(messages, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = messages.find((m) => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${type}`));
      setTimeout(check, 50);
    };
    check();
  });
}

async function run() {
  console.log('\n🧪 SecureChat Relay — Message Queue Tests\n');

  console.log('── Connect ──');
  const alice = await connect(ALICE_ID);
  const bob   = await connect(BOB_ID);
  assert('Alice connected', alice.messages.some((m) => m.type === 'connected'));
  assert('Bob connected',   bob.messages.some((m) => m.type === 'connected'));

  console.log('\n── Live delivery (both online) ──');
  const msgId1 = 'msg-live-001';
  alice.ws.send(JSON.stringify({ type: 'send', to: BOB_ID, msg_id: msgId1, payload: PAYLOAD }));
  const ackSent = await waitFor(alice.messages, 'ack_sent');
  assert('Alice gets ack_sent', ackSent.msg_id === msgId1);
  const liveMsg = await waitFor(bob.messages, 'message');
  assert('Bob receives live message', liveMsg.msg_id === msgId1 && liveMsg.from === ALICE_ID);

  console.log('\n── Bob goes offline ──');
  bob.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n── Queue messages while recipient offline ──');
  const queuedIds = ['msg-queued-001', 'msg-queued-002', 'msg-queued-003'];
  for (const id of queuedIds) {
    alice.ws.send(JSON.stringify({ type: 'send', to: BOB_ID, msg_id: id, payload: PAYLOAD }));
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));

  const queuedAcks = alice.messages.filter((m) => m.type === 'ack_queued');
  assert('Alice gets ack_queued for all 3 messages', queuedAcks.length === 3);
  assert('No dropped events fired (old behavior removed)', !alice.messages.some((m) => m.type === 'dropped'));

  console.log('\n── Bob reconnects and receives queued messages ──');
  const bob2 = await connect(BOB_ID);
  await new Promise((r) => setTimeout(r, 300));

  const receivedMessages = bob2.messages.filter((m) => m.type === 'message');
  assert('Bob receives exactly 3 queued messages', receivedMessages.length === 3);
  assert(
    'Queued messages arrive in FIFO order',
    receivedMessages.map((m) => m.msg_id).join(',') === queuedIds.join(',')
  );
  assert('All queued messages have correct sender', receivedMessages.every((m) => m.from === ALICE_ID));
  assert('Payload is untouched ciphertext', receivedMessages.every((m) => m.payload === PAYLOAD));

  console.log('\n── Queue is cleared after flush ──');
  bob2.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  const bob3 = await connect(BOB_ID);
  await new Promise((r) => setTimeout(r, 300));
  const bob3Messages = bob3.messages.filter((m) => m.type === 'message');
  assert('No leftover messages after queue was already flushed', bob3Messages.length === 0);

  console.log('\n── ACK queue (regression) ──');
  alice.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  bob3.ws.send(JSON.stringify({ type: 'ack_seen', msg_id: 'msg-queued-001', to: ALICE_ID }));
  await new Promise((r) => setTimeout(r, 200));
  const alice2 = await connect(ALICE_ID);
  alice2.ws.send(JSON.stringify({ type: 'pull_acks', device_id: ALICE_ID }));
  await new Promise((r) => setTimeout(r, 300));
  const pending = alice2.messages.find((m) => m.type === 'pending_acks');
  assert('pull_acks still works alongside message queue', pending && pending.acks.length === 1);

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

  alice2.ws.close();
  bob3.ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
