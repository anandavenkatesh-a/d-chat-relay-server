/**
 * test.js
 * Simulates two devices (Alice & Bob) to verify all relay events work correctly.
 * Run with: node test.js
 *
 * Tests covered:
 *  1. connect       — both devices register
 *  2. send          — Alice sends encrypted blob to Bob
 *  3. ack_sent      — relay ACKs Alice immediately
 *  4. message       — Bob receives the blob
 *  5. ack_stored    — Bob confirms he stored it
 *  6. ack_seen      — Bob marks it as seen
 *  7. dropped       — message to offline device is dropped
 *  8. pull_acks     — Alice goes offline, comes back, pulls queued ACKs
 */

const WebSocket = require('ws');

const RELAY = 'ws://localhost:9091';

const ALICE_ID = 'alice_device_sha256_aaaa';
const BOB_ID   = 'bob_device_sha256_bbbb';
const MSG_ID   = 'msg-uuid-001';
const PAYLOAD  = 'BASE64_ENCRYPTED_CIPHERTEXT_OPAQUE_TO_RELAY';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function connect(deviceId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connect', device_id: deviceId }));
    });
    ws.once('message', (raw) => {
      const data = JSON.parse(raw);
      assert(`${deviceId} connected`, data.type === 'connected' && data.device_id === deviceId);
      resolve(ws);
    });
  });
}

function waitForMessage(ws, expectedType) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const data = JSON.parse(raw);
      if (data.type === expectedType) {
        ws.removeListener('message', handler);
        resolve(data);
      }
    };
    ws.on('message', handler);
  });
}

async function runTests() {
  console.log('\n🧪 SecureChat Relay — Integration Tests\n');

  // ── Test 1 & 2: Both devices connect ─────────────────────────────────────
  console.log('── Connect ──');
  const alice = await connect(ALICE_ID);
  const bob   = await connect(BOB_ID);

  // ── Test 3 & 4 & 5: Alice sends message to Bob ───────────────────────────
  console.log('\n── Send Message ──');

  const ackSentPromise    = waitForMessage(alice, 'ack_sent');
  const bobReceivePromise = waitForMessage(bob, 'message');

  alice.send(JSON.stringify({ type: 'send', to: BOB_ID, msg_id: MSG_ID, payload: PAYLOAD }));

  const ackSent = await ackSentPromise;
  assert('Alice gets ack_sent', ackSent.msg_id === MSG_ID);

  const bobMsg = await bobReceivePromise;
  assert('Bob receives message',  bobMsg.from === ALICE_ID);
  assert('Payload is untouched',  bobMsg.payload === PAYLOAD);
  assert('msg_id is preserved',   bobMsg.msg_id === MSG_ID);

  // ── Test 6: Bob sends ack_stored → Alice gets it ─────────────────────────
  console.log('\n── ACK Stored ──');
  const storedPromise = waitForMessage(alice, 'ack_stored');
  bob.send(JSON.stringify({ type: 'ack_stored', msg_id: MSG_ID, to: ALICE_ID }));
  const storedAck = await storedPromise;
  assert('Alice gets ack_stored', storedAck.msg_id === MSG_ID);

  // ── Test 7: Bob sends ack_seen → Alice gets it ───────────────────────────
  console.log('\n── ACK Seen ──');
  const seenPromise = waitForMessage(alice, 'ack_seen');
  bob.send(JSON.stringify({ type: 'ack_seen', msg_id: MSG_ID, to: ALICE_ID }));
  const seenAck = await seenPromise;
  assert('Alice gets ack_seen', seenAck.msg_id === MSG_ID);

  // ── Test 8: Message to offline device → dropped ──────────────────────────
  console.log('\n── Dropped (offline recipient) ──');
  const droppedPromise = waitForMessage(alice, 'dropped');
  alice.send(JSON.stringify({ type: 'send', to: 'offline_device_xyz', msg_id: 'msg-002', payload: PAYLOAD }));
  const dropped = await droppedPromise;
  assert('Message dropped when recipient offline', dropped.msg_id === 'msg-002');

  // ── Test 9: ACK queue — Alice offline, Bob ACKs, Alice pulls on reconnect ─
  console.log('\n── ACK Queue (offline sender + pull_acks) ──');

  // Alice disconnects
  alice.close();
  await new Promise((r) => setTimeout(r, 300));

  // Bob sends ack_seen for a new message (Alice is offline — should be queued)
  const MSG_ID_2 = 'msg-uuid-003';
  bob.send(JSON.stringify({ type: 'ack_seen', msg_id: MSG_ID_2, to: ALICE_ID }));
  await new Promise((r) => setTimeout(r, 200));

  // Alice reconnects
  const alice2 = await connect(ALICE_ID);

  // Pull queued ACKs
  const pullPromise = waitForMessage(alice2, 'pending_acks');
  alice2.send(JSON.stringify({ type: 'pull_acks', device_id: ALICE_ID }));
  const pullResult = await pullPromise;

  assert('pull_acks returns array',          Array.isArray(pullResult.acks));
  assert('Queued ACK delivered after reconnect',
    pullResult.acks.some((a) => a.msgId === MSG_ID_2 && a.status === 'seen')
  );

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

  alice2.close();
  bob.close();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
