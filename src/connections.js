/**
 * connections.js
 * Manages the in-memory map of device_id → WebSocket.
 * No persistence — if relay restarts, devices reconnect automatically.
 */

const connections = new Map(); // device_id → ws

function register(deviceId, ws) {
  connections.set(deviceId, ws);
  console.log(`[+] Device connected: ${deviceId} | Total: ${connections.size}`);
}

function unregister(deviceId) {
  connections.delete(deviceId);
  console.log(`[-] Device disconnected: ${deviceId} | Total: ${connections.size}`);
}

function getSocket(deviceId) {
  return connections.get(deviceId) || null;
}

function isOnline(deviceId) {
  return connections.has(deviceId);
}

function send(deviceId, payload) {
  const ws = getSocket(deviceId);
  if (!ws) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error(`[!] Failed to send to ${deviceId}:`, err.message);
    unregister(deviceId);
    return false;
  }
}

module.exports = { register, unregister, getSocket, isOnline, send };
