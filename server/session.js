// ============================================================================
// server/session.js — per-connection message dispatch + input hardening.
//
// This is the trust boundary. Everything arriving on a socket is hostile until
// validated here: names and free text are stripped of control characters and
// length-clamped, ids are clamped, and every handler runs inside one try/catch
// so a single malformed message can never crash the process (Part D).
//
// The engine (../js/state.js) already enforces the RULES — including that only
// the host may start/configure/kick/advance-reveals. In server mode the room's
// OWNER is the engine's host, so those owner-only intents are enforced by the
// engine automatically; `endGame` is the one server-only owner control, guarded
// here explicitly.
//
// SECURITY — mid-game seat reclaim (Part D): a disconnected seat may be
// reclaimed mid-game ONLY by presenting the secret per-device `clientId` that
// originally took it. Names are public (they show in lobby/state), so allowing a
// name to reclaim a live seat would let a stranger steal that seat and its
// hidden role. We enforce the clientId requirement HERE, in the server layer —
// not in the shared engine, which the trusted peer-to-peer path also uses and
// which is allowed to trust its local clientId.
// ============================================================================

import { PHASES } from '../js/state.js';

const NAME_MAX = 14;
const CLIENTID_MAX = 64;
const CODE_LEN = 4;
const GUESS_MAX = 100;
const CONFIG_STR_MAX = 32;

const CTRL = /\p{Cc}/gu; // Unicode control chars — never legitimate in these fields.

function cleanName(name) {
  return String(name == null ? '' : name).replace(CTRL, '').trim().slice(0, NAME_MAX) || 'Player';
}
function cleanClientId(id) {
  if (typeof id !== 'string') return null;
  const c = id.replace(CTRL, '').trim().slice(0, CLIENTID_MAX);
  return c || null;
}
function cleanCode(code) {
  return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LEN);
}
function cleanText(text, max) {
  return String(text == null ? '' : text).replace(CTRL, '').slice(0, max);
}
function asId(x) {
  return typeof x === 'string' ? x.slice(0, CLIENTID_MAX) : null;
}
function cleanConfig(msg) {
  const c = {};
  if (typeof msg.category === 'string') c.category = msg.category.slice(0, CONFIG_STR_MAX);
  if (msg.tieBreak !== undefined) c.tieBreak = typeof msg.tieBreak === 'string' ? msg.tieBreak.slice(0, CONFIG_STR_MAX) : null;
  if (msg.undercover !== undefined) c.undercover = Number(msg.undercover);
  if (msg.mrwhite !== undefined) c.mrwhite = !!msg.mrwhite;
  if (msg.timer !== undefined) c.timer = !!msg.timer;
  if (msg.timerSeconds !== undefined) c.timerSeconds = Number(msg.timerSeconds);
  return c;
}

// Map an engine rejection string to a machine-readable reason so the client can
// decide whether to fall back to peer-to-peer (only for a genuinely-missing room).
function reasonFor(error) {
  const e = String(error || '').toLowerCase();
  if (e.includes('already started')) return 'started';
  if (e.includes('full')) return 'full';
  if (e.includes('taken')) return 'name_taken';
  return undefined;
}

function safeSend(ws, msg) {
  try { if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg)); } catch (_) { /* torn down */ }
}

/** Fresh per-connection state. `connId` doubles as the engine player id for the
 *  seat this socket holds (a reconnect is a new socket → new id → engine remaps
 *  the seat by clientId). */
export function makeSession(connId) {
  return { connId: String(connId), clientId: null, code: null, playerId: null, owner: false };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
export function handleMessage(rooms, ws, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  try {
    if (msg.type === 'createRoom') return onCreateRoom(rooms, ws, msg);
    if (msg.type === 'join')       return onJoin(rooms, ws, msg);
    return onIntent(rooms, ws, msg);
  } catch (_) {
    safeSend(ws, { type: 'error', message: 'The server could not process that action.' });
  }
}

function onCreateRoom(rooms, ws, msg) {
  const s = ws.session;
  if (s.code) { safeSend(ws, { type: 'rejected', message: 'You already have a game open.' }); return; }
  if (rooms.atCapacity()) {
    safeSend(ws, { type: 'rejected', message: 'The server is busy right now — try hosting locally instead.' });
    return;
  }
  const room = rooms.create();
  if (!room) { safeSend(ws, { type: 'rejected', message: 'The server is busy right now — try hosting locally instead.' }); return; }

  const name = cleanName(msg.name);
  const clientId = cleanClientId(msg.clientId);
  const playerId = s.connId;

  const res = room.engine.addPlayer({ id: playerId, name, clientId, isHost: true });
  if (!res.ok) { rooms.delete(room.code); safeSend(ws, { type: 'rejected', message: res.error }); return; }

  room.ownerClientId = clientId;
  room.attach(playerId, ws);
  s.code = room.code; s.playerId = playerId; s.clientId = clientId; s.owner = true;

  safeSend(ws, { type: 'welcome', playerId, code: room.code, owner: true });
  room.touch();
  room.broadcast();
}

function onJoin(rooms, ws, msg) {
  const s = ws.session;
  if (s.code) { safeSend(ws, { type: 'rejected', message: 'You already have a game open.' }); return; }

  const code = cleanCode(msg.code);
  if (code.length !== CODE_LEN) {
    safeSend(ws, { type: 'rejected', reason: 'no_room', message: 'Enter the 4-letter room code.' });
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    // The one reason that tells the client to retry this code over peer-to-peer.
    safeSend(ws, { type: 'rejected', reason: 'no_room', message: 'No game found with that code.' });
    return;
  }

  const name = cleanName(msg.name);
  const clientId = cleanClientId(msg.clientId);

  // Part D: mid-game, a seat can be (re)taken ONLY with the secret clientId that
  // already holds it. No clientId match mid-game → treated as a new join, which
  // is refused. This blocks name-only theft of a disconnected player's role.
  const seat = clientId ? room.engine.players.find((p) => p.clientId && p.clientId === clientId) : null;
  if (room.engine.phase !== PHASES.LOBBY && !seat) {
    safeSend(ws, { type: 'rejected', reason: 'started', message: 'This game has already started.' });
    return;
  }

  const oldId = seat ? seat.id : null;
  const playerId = s.connId;
  const res = room.engine.addPlayer({ id: playerId, name, clientId });
  if (!res.ok) {
    safeSend(ws, { type: 'rejected', reason: reasonFor(res.error), message: res.error });
    return;
  }

  if (res.reconnected && oldId) {
    const oldWs = room.members.get(oldId);
    room.remapMember(oldId, playerId, ws);
    if (oldWs && oldWs !== ws) { try { oldWs.close(); } catch (_) {} } // retire the stale connection
  } else {
    room.attach(playerId, ws);
  }

  s.code = code; s.playerId = playerId; s.clientId = clientId;
  s.owner = room.isOwnerClient(clientId);

  safeSend(ws, { type: 'welcome', playerId, code, owner: s.owner });
  room.touch();
  room.broadcast();
}

function onIntent(rooms, ws, msg) {
  const s = ws.session;
  if (!s.code || !s.playerId) { safeSend(ws, { type: 'error', message: 'Join or host a game first.' }); return; }
  const room = rooms.get(s.code);
  if (!room) { safeSend(ws, { type: 'error', message: 'This game is no longer available.' }); return; }

  if (msg.type === 'endGame') return onEndGame(rooms, room, ws);

  const eng = room.engine;
  const actorId = s.playerId;
  let res = { ok: true };

  switch (msg.type) {
    case 'config':        res = eng.setConfig(actorId, cleanConfig(msg)); break;
    case 'start':         res = eng.startGame(actorId); break;
    case 'ready':         res = eng.setReady(actorId); break;
    case 'beginDescribe': res = eng.beginDescribe(actorId); break;
    case 'advance':       res = eng.advanceSpeaker(actorId); break;
    case 'vote':          res = eng.castVote(actorId, asId(msg.target)); break;
    case 'forceResolve':  res = eng.forceResolveVote(actorId); break;
    case 'continue':      res = eng.continueAfterReveal(actorId); break;
    case 'guess':         res = eng.submitWhiteGuess(actorId, cleanText(msg.text, GUESS_MAX)); break;
    case 'skipGuess':     res = eng.skipWhiteGuess(actorId); break;
    case 'playAgain':     res = eng.playAgain(actorId); break;
    case 'kick':          res = onKick(room, actorId, asId(msg.target)); break;
    case 'leave':         eng.markOffline(actorId); break;
    default:              res = { ok: false, error: 'Unknown action.' }; break;
  }

  if (res && res.ok === false && res.error) safeSend(ws, { type: 'error', message: res.error });
  room.touch();
  room.broadcast();
}

function onKick(room, actorId, targetId) {
  const res = room.engine.kickPlayer(actorId, targetId);
  if (res.ok && targetId) {
    const sock = room.members.get(targetId);
    if (sock) {
      safeSend(sock, { type: 'kicked' });
      room.detach(targetId, sock);
      try { sock.close(); } catch (_) {}
    }
  }
  return res;
}

function onEndGame(rooms, room, ws) {
  if (!ws.session.owner) { safeSend(ws, { type: 'error', message: 'Only the host can end the game.' }); return; }
  for (const [, sock] of [...room.members]) {
    if (sock !== ws) { safeSend(sock, { type: 'error', message: 'The host ended the game.' }); try { sock.close(); } catch (_) {} }
  }
  rooms.delete(room.code); // stops timers; the owner's own socket closes client-side
}

// A socket dropped: free its lobby seat (or mark it offline mid-game so it can
// be reclaimed), then refresh everyone still connected.
export function handleClose(rooms, ws) {
  const s = ws.session;
  if (!s || !s.code || !s.playerId) return;
  const room = rooms.get(s.code);
  if (!room) return;
  room.detach(s.playerId, ws);
  try { room.engine.markOffline(s.playerId); } catch (_) {}
  room.touch();
  room.broadcast();
}

// Exported for the test harness.
export const _internals = { cleanName, cleanClientId, cleanCode, cleanText, cleanConfig, reasonFor };
