// ============================================================================
// server/index.js — HTTP + WebSocket bootstrap for the authoritative game host.
//
// One tiny Node process serves any number of rooms. It is prefix-agnostic: the
// reverse proxy strips the "/undercover/" path before forwarding, so this server
// only ever sees "/health" and "/". Listens on :9000 by convention.
//
//   GET /health   → JSON liveness (CORS *). The browser probes this at boot to
//                   decide whether to offer "Host on server".
//   WS  /         → the game transport (see session.js for the wire protocol).
//
// Part D network hardening lives here:
//   - Origin allowlist on the WS upgrade (anti-CSRF; NOT authentication).
//   - maxPayload clamp (game frames are tiny).
//   - Global connection cap (the real DoS backstop — per-IP is meaningless
//     behind the Funnel, where the client IP isn't exposed).
//   - Per-connection token-bucket rate limit (floods are dropped, never
//     amplified into a room-wide broadcast).
//   - One room per socket (a client can't exhaust the room cap alone).
//   - Heartbeat ping/pong to reap dead sockets so they don't hold cap slots.
// ============================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { makeSession, handleMessage, handleClose } from './session.js';

// --- Config (env with sane defaults) ---------------------------------------
const PORT = Number(process.env.PORT) || 9000;
const APP_VERSION = process.env.APP_VERSION || 'dev';
const PROD = process.env.NODE_ENV === 'production';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://iamyvj.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_CONNS   = Number(process.env.MAX_CONNS)   || 400;    // global socket cap
const MAX_ROOMS   = Number(process.env.MAX_ROOMS)   || 200;    // global room cap
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 6 * 60 * 60 * 1000;
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD) || 64 * 1024; // 64 KiB frames

// Token bucket: sustained rate + short burst. Game play is a few messages a
// second at most; anything above this is abuse, so we drop the overflow.
const RATE_BURST   = Number(process.env.RATE_BURST)   || 30;   // bucket capacity
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC) || 15;   // refill rate
const RATE_STRIKES = Number(process.env.RATE_STRIKES) || 400;  // drops before we cut a flooder

const HEARTBEAT_MS = 30 * 1000;

// --- Origin policy ---------------------------------------------------------
// Treat the allowlist as anti-CSRF, not auth: a non-browser client can forge
// Origin, but this stops a random web page from driving a user's socket.
function originAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (!origin) return !PROD;                       // header-less: dev only
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (!PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

// --- Token bucket ----------------------------------------------------------
class TokenBucket {
  constructor(capacity, perSec) { this.capacity = capacity; this.perSec = perSec; this.tokens = capacity; this.last = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// --- Wire send (guarded) ---------------------------------------------------
function send(ws, msg) {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } catch (_) { /* torn down */ }
}

// --- Rooms -----------------------------------------------------------------
const rooms = new RoomManager({ send, maxRooms: MAX_ROOMS, roomTtlMs: ROOM_TTL_MS });
rooms.startGC();

// --- HTTP (health + friendly root) -----------------------------------------
const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: true, name: 'undercover', version: APP_VERSION,
      rooms: rooms.size, conns: wss ? wss.clients.size : 0,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Undercover game server OK');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

// --- WebSocket -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

httpServer.on('upgrade', (req, socket, head) => {
  // Cap first — cheapest rejection, and the real DoS backstop.
  if (wss.clients.size >= MAX_CONNS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  if (!originAllowed(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let nextConnId = 1;

wss.on('connection', (ws) => {
  ws.session = makeSession(`c${nextConnId++}`);
  ws.isAlive = true;
  const bucket = new TokenBucket(RATE_BURST, RATE_PER_SEC);
  let strikes = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    if (!bucket.take()) {                 // over budget — drop, and cut persistent flooders
      if (++strikes > RATE_STRIKES) { try { ws.close(1008, 'rate limit'); } catch (_) {} }
      return;
    }
    let msg = null;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch (_) { return; }
    handleMessage(rooms, ws, msg);
  });

  ws.on('close', () => { handleClose(rooms, ws); });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

// Reap sockets that stopped answering (half-open connections behind the proxy).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

// --- Lifecycle -------------------------------------------------------------
httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[undercover] server v${APP_VERSION} listening on :${PORT} · prod=${PROD} · origins=${ALLOWED_ORIGINS.join(',')}`);
});

function shutdown() {
  clearInterval(heartbeat);
  rooms.stopGC();
  for (const ws of wss.clients) { try { ws.close(1001, 'server shutting down'); } catch (_) {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
