// ============================================================================
// server/rooms.js — in-memory room manager for SERVER-HOSTED games.
//
// This is the authoritative-server counterpart of the browser host. It reuses
// the SAME pure engine (../js/state.js) the peer-to-peer host uses, so the rules
// live in exactly one place. In server mode no browser runs an engine — the
// server owns one GameEngine per room and every connected client (owner
// included) is just a renderer of the state the server pushes.
//
// A Room:
//   - owns one GameEngine,
//   - tracks the OWNER by their stable `clientId` (survives reconnects),
//   - keeps a live socket per seated player (playerId -> ws),
//   - broadcasts publicState() to everyone and privateStateFor(id) to each
//     player individually (secrets never travel in public state mid-game),
//   - runs the describe turn-timer server-side (the owner's phone isn't the
//     clock any more),
//   - is swept away by an idle GC once empty for ROOM_TTL_MS.
//
// Transport is injected (`send(ws, msg)`) so this module never imports `ws`.
// ============================================================================

import crypto from 'node:crypto';
import { GameEngine, PHASES } from '../js/state.js';

// Letter-only, unambiguous (no I/O) — mirrors js/util.js so codes read/type the
// same whether a game is hosted in a browser or on the server.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

class Room {
  constructor(code, mgr) {
    this.code = code;
    this.mgr = mgr;
    this.engine = mgr.newEngine();
    this.ownerClientId = null;          // set on createRoom
    this.members = new Map();           // playerId -> ws (currently connected)
    this.lastActivity = Date.now();
    this.turnTimer = null;
  }

  touch() { this.lastActivity = Date.now(); }

  isOwnerClient(clientId) {
    return !!clientId && clientId === this.ownerClientId;
  }

  // Point a seat's live socket at `ws`. Any prior socket for that seat is
  // returned so the caller can retire it (a reconnect adopts the newest one).
  attach(playerId, ws) {
    const prev = this.members.get(playerId);
    this.members.set(playerId, ws);
    return prev && prev !== ws ? prev : null;
  }

  detach(playerId, ws) {
    // Only drop the mapping if THIS socket still owns the seat — a stale close
    // from an old connection must not evict a player who already reconnected.
    if (this.members.get(playerId) === ws) this.members.delete(playerId);
  }

  // Re-key a seat's live socket after the engine remaps a reconnecting player
  // from oldId to newId.
  remapMember(oldId, newId, ws) {
    if (oldId !== newId) this.members.delete(oldId);
    this.members.set(newId, ws);
  }

  send(ws, msg) { this.mgr.send(ws, msg); }

  // Push each connected player their own personalised snapshot.
  broadcast() {
    const pub = this.engine.publicState();
    for (const [playerId, ws] of this.members) {
      this.send(ws, { type: 'state', pub, priv: this.engine.privateStateFor(playerId) });
    }
    this.scheduleTurnTimer();
  }

  sendStateTo(playerId) {
    const ws = this.members.get(playerId);
    if (!ws) return;
    this.send(ws, {
      type: 'state',
      pub: this.engine.publicState(),
      priv: this.engine.privateStateFor(playerId),
    });
  }

  // Server-side describe timer: when the turn clock is on, auto-advance the
  // current speaker the instant their time runs out (the owner or speaker can
  // still advance early). Mirrors the browser host's scheduleTurnTimer.
  scheduleTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    const pub = this.engine.publicState();
    if (pub.phase !== PHASES.DESCRIBE || !pub.describe || !pub.describe.endsAt) return;
    const fire = () => {
      this.turnTimer = null;
      const p = this.engine.publicState();
      if (p.phase === PHASES.DESCRIBE && p.describe && p.describe.endsAt
          && Date.now() >= p.describe.endsAt - 200) {
        const actor = this.engine.hostId;
        if (actor) this.engine.advanceSpeaker(actor);
        this.touch();
        this.broadcast();
      } else {
        this.scheduleTurnTimer(); // clock moved on — re-arm for the new turn
      }
    };
    this.turnTimer = setTimeout(fire, Math.max(0, pub.describe.endsAt - Date.now()));
  }

  stopTimers() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
  }

  // A room is collectable once nobody is connected and it's been idle a while,
  // or immediately if it has no seats at all (everyone left in the lobby).
  isCollectable(now, ttlMs) {
    if (this.members.size > 0) return false;
    if (this.engine.players.length === 0) return true;
    return (now - this.lastActivity) > ttlMs;
  }
}

export class RoomManager {
  constructor(opts = {}) {
    this.send = opts.send || (() => {});
    this.maxRooms = opts.maxRooms || 200;
    this.roomTtlMs = opts.roomTtlMs || 6 * 60 * 60 * 1000; // 6h, matches client session TTL
    this.newEngine = opts.newEngine || (() => new GameEngine());
    this.rooms = new Map(); // code -> Room
    this._gc = null;
  }

  get size() { return this.rooms.size; }

  get(code) { return this.rooms.get(code) || null; }

  atCapacity() { return this.rooms.size >= this.maxRooms; }

  // Make a fresh room under an unused code. Returns the Room (never overwrites).
  create() {
    if (this.atCapacity()) return null;
    let code = randomCode();
    // Astronomically unlikely to collide, but never clobber a live room.
    for (let i = 0; i < 8 && this.rooms.has(code); i++) code = randomCode();
    if (this.rooms.has(code)) return null;
    const room = new Room(code, this);
    this.rooms.set(code, room);
    return room;
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.stopTimers();
    this.rooms.delete(code);
  }

  startGC(intervalMs = 60 * 1000) {
    if (this._gc) return;
    this._gc = setInterval(() => this.sweep(), intervalMs);
    if (this._gc.unref) this._gc.unref(); // don't keep the process alive for GC alone
  }

  stopGC() { if (this._gc) { clearInterval(this._gc); this._gc = null; } }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (room.isCollectable(now, this.roomTtlMs)) { this.delete(code); removed++; }
    }
    return removed;
  }
}

export { Room, randomCode, CODE_ALPHABET, CODE_LENGTH };
