// Correctness + security harness for the SERVER layer (rooms.js + session.js).
// No real WebSocket: stub sockets record what the server would have sent. This
// drives a full server-hosted game and the Part D security regressions.
// Run: node scripts/test-server.mjs
import { RoomManager } from '../server/rooms.js';
import { makeSession, handleMessage, handleClose, _internals } from '../server/session.js';
import { GameEngine, PHASES } from '../js/state.js';
import { ROLES, TIE_BREAK } from '../js/rules.js';
import { MIXED } from '../js/words.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// Deterministic RNG (mulberry32) so role deals + word pairs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Stub socket — mirrors the tiny slice of the `ws` API the server touches:
// `readyState`/`send()` for delivery, `close()` for teardown, plus a `session`
// (assigned by the real connection handler). Received frames are parsed back
// into objects so tests can assert on them.
// ---------------------------------------------------------------------------
class StubSocket {
  constructor(id) {
    this.id = id;
    this.OPEN = 1;
    this.readyState = 1; // OPEN
    this.inbox = [];
    this.closed = false;
    this.session = null;
  }
  send(raw) {
    if (this.readyState !== 1) return; // a real socket silently drops post-close
    try { this.inbox.push(typeof raw === 'string' ? JSON.parse(raw) : raw); }
    catch (_) { this.inbox.push(raw); }
  }
  close() { this.closed = true; this.readyState = 3; /* CLOSED */ }
  lastOfType(t) {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i] && this.inbox[i].type === t) return this.inbox[i];
    return null;
  }
  hasType(t) { return this.inbox.some((m) => m && m.type === t); }
  clear() { this.inbox = []; }
}

// A RoomManager wired exactly like index.js: the injected `send` stringifies and
// respects readyState, so the stub round-trips through JSON just like the wire.
function makeRooms(seed = 1, opts = {}) {
  return new RoomManager({
    send: (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    newEngine: () => new GameEngine({ rng: seed == null ? Math.random : rng(seed) }),
    ...opts,
  });
}

function connect(id) { const ws = new StubSocket(id); ws.session = makeSession(id); return ws; }
function send(rooms, ws, msg) { handleMessage(rooms, ws, msg); }
function close(rooms, ws) { ws.readyState = 3; handleClose(rooms, ws); }

// Stand up a lobby: owner (connId 'owner', clientId 'c-owner') + n-1 joiners
// ('p1'.. with clientId 'c1'..). Returns the code, sockets keyed by connId, and
// the connId order. Engine player id === connId (no reconnects here).
function makeLobby(rooms, n) {
  const names = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gwen', 'Hal'];
  const owner = connect('owner');
  send(rooms, owner, { type: 'createRoom', name: names[0], clientId: 'c-owner' });
  const code = owner.lastOfType('welcome').code;
  const sockets = { owner };
  const ids = ['owner'];
  for (let i = 1; i < n; i++) {
    const cid = 'p' + i;
    const ws = connect(cid);
    send(rooms, ws, { type: 'join', code, name: names[i], clientId: 'c' + i });
    sockets[cid] = ws;
    ids.push(cid);
  }
  return { code, owner, sockets, ids };
}

// ===========================================================================
// INPUT HARDENING (Part D) — the trust boundary sanitisers.
// ===========================================================================
{
  const { cleanName, cleanClientId, cleanCode, cleanText, cleanConfig, reasonFor } = _internals;

  eq(cleanName('  Aria  '), 'Aria', 'cleanName trims');
  eq(cleanName(''), 'Player', 'cleanName empty -> Player');
  eq(cleanName(null), 'Player', 'cleanName null -> Player');
  eq(cleanName('   '), 'Player', 'cleanName whitespace-only -> Player');
  eq(cleanName('a'.repeat(50)).length, 14, 'cleanName clamps to 14');
  eq(cleanName('A\u0000B\u0007C'), 'ABC', 'cleanName strips control chars');
  eq(cleanName('Zoë\tX'), 'ZoëX', 'cleanName strips tab, keeps unicode letters');

  eq(cleanClientId('   '), null, 'cleanClientId blank -> null');
  eq(cleanClientId(123), null, 'cleanClientId non-string -> null');
  eq(cleanClientId('x'.repeat(100)).length, 64, 'cleanClientId clamps to 64');
  eq(cleanClientId('a\u0000b'), 'ab', 'cleanClientId strips control chars');

  eq(cleanCode('ab-cd'), 'ABCD', 'cleanCode uppercases + drops non-letters');
  eq(cleanCode('abcdef'), 'ABCD', 'cleanCode clamps to 4');
  eq(cleanCode('12ab'), 'AB', 'cleanCode drops digits');
  eq(cleanCode(null), '', 'cleanCode null -> empty');

  eq(cleanText('ab\u0000cd', 10), 'abcd', 'cleanText strips control chars');
  eq(cleanText('abcdef', 3), 'abc', 'cleanText clamps to max');
  eq(cleanText(null, 10), '', 'cleanText null -> empty');

  const cfg = cleanConfig({
    category: 'x'.repeat(50), undercover: '3', mrwhite: 1, timer: 1,
    timerSeconds: '45', tieBreak: 'runoff', bogus: 'nope',
  });
  eq(cfg.category.length, 32, 'cleanConfig clamps category to 32');
  eq(cfg.undercover, 3, 'cleanConfig coerces undercover to Number');
  eq(cfg.mrwhite, true, 'cleanConfig coerces mrwhite to boolean');
  eq(cfg.timer, true, 'cleanConfig coerces timer to boolean');
  eq(cfg.timerSeconds, 45, 'cleanConfig coerces timerSeconds to Number');
  eq(cfg.tieBreak, 'runoff', 'cleanConfig keeps tieBreak string');
  ok(!('bogus' in cfg), 'cleanConfig drops unknown keys');

  eq(reasonFor('The game has already started.'), 'started', 'reasonFor: started');
  eq(reasonFor('Room is full (max 20).'), 'full', 'reasonFor: full');
  eq(reasonFor('That name is taken. Pick another.'), 'name_taken', 'reasonFor: name_taken');
  eq(reasonFor('some other error'), undefined, 'reasonFor: unknown -> undefined');
}

// A hostile name is sanitised in the actual seat, not just in a helper.
{
  const rooms = makeRooms(1);
  const owner = connect('owner');
  send(rooms, owner, { type: 'createRoom', name: 'Ab\u0000' + 'x'.repeat(30), clientId: 'c-owner' });
  const seat = rooms.get(owner.lastOfType('welcome').code).engine.players[0];
  ok(!/\p{Cc}/u.test(seat.name), 'seat name has no control chars');
  ok(seat.name.length <= 14, 'seat name clamped to <= 14');
}

// ===========================================================================
// ROOM LIFECYCLE — create / join / caps / GC.
// ===========================================================================

// createRoom → welcome(owner:true) + code + first state.
{
  const rooms = makeRooms(1);
  const owner = connect('owner');
  send(rooms, owner, { type: 'createRoom', name: 'Alice', clientId: 'c-owner' });
  const wel = owner.lastOfType('welcome');
  ok(wel && wel.owner === true, 'createRoom: welcome marks owner');
  ok(wel && typeof wel.code === 'string' && wel.code.length === 4, 'createRoom: 4-letter code minted');
  eq(wel.playerId, 'owner', 'createRoom: playerId is the connId');
  const st = owner.lastOfType('state');
  ok(st && st.pub && st.pub.phase === PHASES.LOBBY, 'createRoom: first state is the lobby');
  ok(rooms.size === 1, 'createRoom: room registered');
}

// join an existing room → welcome(owner:false) + state; roster grows.
{
  const rooms = makeRooms(1);
  const { code, owner } = makeLobby(rooms, 3);
  const j = owner.lastOfType('state');
  eq(j.pub.players.length, 3, 'join: three players in the lobby');
  const ws = connect('p9');
  send(rooms, ws, { type: 'join', code, name: 'Zoe', clientId: 'c9' });
  const p1wel = ws.lastOfType('welcome');
  ok(p1wel && p1wel.owner === false, 'join: joiner is not the owner');
}

// One game per socket: a second create/join on the same socket is refused.
{
  const rooms = makeRooms(1);
  const owner = connect('owner');
  send(rooms, owner, { type: 'createRoom', name: 'Alice', clientId: 'c-owner' });
  owner.clear();
  send(rooms, owner, { type: 'createRoom', name: 'Alice', clientId: 'c-owner' });
  ok(owner.lastOfType('rejected'), 'second createRoom on same socket rejected');
  owner.clear();
  send(rooms, owner, { type: 'join', code: 'ABCD', name: 'Alice', clientId: 'c-owner' });
  ok(owner.lastOfType('rejected'), 'join while already hosting rejected');
}

// Joining a code that has no server room → reason 'no_room' (the client's cue to
// fall back to peer-to-peer). Same for a malformed code.
{
  const rooms = makeRooms(1);
  const ws = connect('x');
  send(rooms, ws, { type: 'join', code: 'ZZZZ', name: 'Nobody', clientId: 'cx' });
  eq(ws.lastOfType('rejected').reason, 'no_room', 'join unknown code -> no_room');
  const ws2 = connect('y');
  send(rooms, ws2, { type: 'join', code: 'ZZ', name: 'Nobody', clientId: 'cy' });
  eq(ws2.lastOfType('rejected').reason, 'no_room', 'join malformed code -> no_room');
}

// Duplicate name in the lobby → reason 'name_taken'.
{
  const rooms = makeRooms(1);
  const { code } = makeLobby(rooms, 2);
  const dup = connect('dupe');
  send(rooms, dup, { type: 'join', code, name: 'Alice', clientId: 'c-dupe' });
  eq(dup.lastOfType('rejected').reason, 'name_taken', 'duplicate lobby name -> name_taken');
}

// Global room cap: onCreateRoom refuses once the manager is full.
{
  const rooms = makeRooms(1, { maxRooms: 1 });
  const a = connect('a');
  send(rooms, a, { type: 'createRoom', name: 'Alice', clientId: 'ca' });
  ok(rooms.size === 1, 'cap: first room created');
  const b = connect('b');
  send(rooms, b, { type: 'createRoom', name: 'Bob', clientId: 'cb' });
  ok(b.lastOfType('rejected') && !b.hasType('welcome'), 'cap: create refused at capacity');
  ok(rooms.size === 1, 'cap: no extra room created');
}

// GC: a bare/empty room is collectable and swept; a live one is not.
{
  const rooms = makeRooms(1);
  const bare = rooms.create();
  ok(bare.isCollectable(Date.now(), 60000), 'GC: bare room (no seats/members) collectable');
  eq(rooms.sweep(Date.now()), 1, 'GC: sweep removes the bare room');
  eq(rooms.size, 0, 'GC: manager empty after sweep');

  const owner = connect('owner');
  send(rooms, owner, { type: 'createRoom', name: 'Alice', clientId: 'c-owner' });
  const room = rooms.get(owner.lastOfType('welcome').code);
  ok(!room.isCollectable(Date.now(), 60000), 'GC: room with a connected owner not collectable');
  close(rooms, owner); // lobby drop frees the seat -> no players, no members
  ok(room.isCollectable(Date.now(), 60000), 'GC: room empties out and becomes collectable');
}

// ===========================================================================
// FULL GAME OVER THE WIRE — transitions, secrecy, winner.
// ===========================================================================
{
  const rooms = makeRooms(7);
  const room = makeLobby(rooms, 4);
  const eng = rooms.get(room.code).engine;

  // Config + start.
  send(rooms, room.owner, {
    type: 'config', undercover: 1, mrwhite: false, category: MIXED, tieBreak: TIE_BREAK.RUNOFF_RANDOM,
  });
  send(rooms, room.owner, { type: 'start' });
  eq(eng.phase, PHASES.ROLE_REVEAL, 'game: start -> role reveal');

  // SECRECY: public state leaks no living roles/words; each player's private
  // state reveals only their own role/word.
  for (const id of room.ids) {
    const st = room.sockets[id].lastOfType('state');
    ok(st.pub.players.every((p) => p.role === null), `secrecy: no living roles in public state (${id})`);
    ok(st.pub.words === undefined && st.pub.final === undefined, `secrecy: no words/final leaked mid-game (${id})`);
    eq(st.priv.id, id, `private state is addressed to ${id}`);
    eq(st.priv.role, eng.getPlayer(id).roleId, `private role matches the engine seat (${id})`);
  }
  const ucSeat = eng.players.find((p) => p.roleId === ROLES.UNDERCOVER);
  const civSeat = eng.players.find((p) => p.roleId === ROLES.CIVILIAN);
  eq(room.sockets[ucSeat.id].lastOfType('state').priv.word, eng.words.undercoverWord, 'undercover sees the undercover word');
  eq(room.sockets[civSeat.id].lastOfType('state').priv.word, eng.words.civilianWord, 'civilian sees the civilian word');
  ok(eng.words.undercoverWord !== eng.words.civilianWord, 'the two secret words differ');

  // Ready → describe.
  for (const id of room.ids) send(rooms, room.sockets[id], { type: 'ready' });
  eq(eng.phase, PHASES.DESCRIBE, 'game: all ready -> describe');

  // Describe (host advances each speaker) → vote.
  let guard = 0;
  while (eng.phase === PHASES.DESCRIBE && guard++ < 60) send(rooms, room.owner, { type: 'advance' });
  eq(eng.phase, PHASES.VOTE, 'game: describing done -> vote');

  // Everyone votes out the undercover → reveal → continue → gameover.
  const alive = eng.alivePlayers().map((p) => p.id);
  const other = alive.find((id) => id !== ucSeat.id);
  for (const id of alive) send(rooms, room.sockets[id], { type: 'vote', target: id === ucSeat.id ? other : ucSeat.id });
  eq(eng.phase, PHASES.REVEAL, 'game: majority -> reveal');
  send(rooms, room.owner, { type: 'continue' });
  eq(eng.phase, PHASES.GAMEOVER, 'game: continue -> gameover');
  eq(eng.winner, 'civilians', 'game: civilians win by voting out the undercover');

  // Final state now reveals the words to everyone.
  const fin = room.owner.lastOfType('state');
  ok(fin.pub.final && fin.pub.final.words, 'gameover: words revealed in the final public state');
}

// ===========================================================================
// PART D — mid-game seat reclaim requires the secret clientId, NOT a name.
// ===========================================================================
{
  const rooms = makeRooms(7);
  const room = makeLobby(rooms, 4);
  const eng = rooms.get(room.code).engine;

  // Reach a mid-game phase.
  send(rooms, room.owner, { type: 'config', undercover: 1, mrwhite: false, category: MIXED });
  send(rooms, room.owner, { type: 'start' });
  for (const id of room.ids) send(rooms, room.sockets[id], { type: 'ready' });
  ok(eng.phase !== PHASES.LOBBY, 'reclaim: game is mid-flight');

  // p1 (name 'Bob', clientId 'c1') drops but keeps its offline seat + role.
  const victimRole = eng.getPlayer('p1').roleId;
  close(rooms, room.sockets['p1']);
  const offSeat = eng.players.find((p) => p.clientId === 'c1');
  ok(offSeat && offSeat.online === false, 'reclaim: dropped seat is retained, marked offline');

  // ATTACK: someone joins mid-game with the public NAME but no matching clientId.
  const attacker = connect('evil');
  send(rooms, attacker, { type: 'join', code: room.code, name: 'Bob', clientId: 'evil-cid' });
  eq(attacker.lastOfType('rejected').reason, 'started', 'reclaim: name-only mid-game join is refused');
  ok(!attacker.hasType('welcome') && !attacker.hasType('state'), 'reclaim: attacker gets no seat or state');
  eq(eng.players.length, 4, 'reclaim: attacker did not add a seat');
  eq(eng.players.find((p) => p.clientId === 'c1').roleId, victimRole, 'reclaim: victim role untouched by the attack');

  // LEGIT: the real device rejoins with its secret clientId and recovers its role.
  const back = connect('p1b');
  send(rooms, back, { type: 'join', code: room.code, name: 'Bob', clientId: 'c1' });
  const wel = back.lastOfType('welcome');
  ok(wel && wel.owner === false, 'reclaim: legit rejoin welcomed as non-owner');
  eq(back.lastOfType('state').priv.role, victimRole, 'reclaim: clientId owner recovers the hidden role');
  eq(eng.players.length, 4, 'reclaim: rejoin re-keys the seat, no duplicate');
  ok(eng.players.find((p) => p.clientId === 'c1').online === true, 'reclaim: seat back online');
}

// ===========================================================================
// OWNER CONTROLS — endGame is owner-only; kick works from the owner only.
// ===========================================================================

// endGame: a non-owner is refused; the owner tears the room down and boots the rest.
{
  const rooms = makeRooms(1);
  const room = makeLobby(rooms, 3);
  send(rooms, room.sockets['p1'], { type: 'endGame' });
  ok(/only the host/i.test(room.sockets['p1'].lastOfType('error').message), 'endGame: non-owner refused');
  ok(rooms.get(room.code), 'endGame: room survives a non-owner attempt');

  send(rooms, room.owner, { type: 'endGame' });
  ok(rooms.get(room.code) === null, 'endGame: owner deletes the room');
  ok(room.sockets['p1'].closed && /host ended/i.test(room.sockets['p1'].lastOfType('error').message),
    'endGame: other members are told and disconnected');
}

// kick: owner removes a lobby player; a non-owner cannot.
{
  const rooms = makeRooms(1);
  const room = makeLobby(rooms, 4);
  const eng = rooms.get(room.code).engine;
  const before = eng.players.length;

  send(rooms, room.sockets['p1'], { type: 'kick', target: 'p2' });
  ok(/only the host/i.test(room.sockets['p1'].lastOfType('error').message), 'kick: non-owner refused');
  eq(eng.players.length, before, 'kick: roster unchanged after refused kick');

  send(rooms, room.owner, { type: 'kick', target: 'p2' });
  ok(room.sockets['p2'].hasType('kicked'), 'kick: target is told it was kicked');
  ok(room.sockets['p2'].closed, 'kick: target socket closed');
  eq(eng.players.length, before - 1, 'kick: owner frees the seat');
}

// ===========================================================================
// ROBUSTNESS — malformed input and out-of-order intents never crash.
// ===========================================================================
{
  const rooms = makeRooms(1);
  const ws = connect('lonely');
  let threw = false;
  try {
    handleMessage(rooms, ws, null);
    handleMessage(rooms, ws, {});
    handleMessage(rooms, ws, { type: 123 });
    handleMessage(rooms, ws, 'not-an-object');
    handleMessage(rooms, ws, []);
  } catch (_) { threw = true; }
  ok(!threw, 'robustness: malformed messages never throw');
  eq(ws.inbox.length, 0, 'robustness: malformed messages produce no reply');

  // An intent before joining is rejected, not applied.
  send(rooms, ws, { type: 'start' });
  ok(/join or host/i.test(ws.lastOfType('error').message), 'robustness: intent before join is refused');
}

// Unknown action from a seated player → a clean error, room intact.
{
  const rooms = makeRooms(1);
  const room = makeLobby(rooms, 3);
  send(rooms, room.sockets['p1'], { type: 'totally-bogus' });
  ok(/unknown action/i.test(room.sockets['p1'].lastOfType('error').message), 'robustness: unknown action -> error');
  ok(rooms.get(room.code), 'robustness: room survives an unknown action');
}

// A lobby disconnect frees the seat and updates everyone still connected.
{
  const rooms = makeRooms(1);
  const room = makeLobby(rooms, 3);
  const eng = rooms.get(room.code).engine;
  room.owner.clear();
  close(rooms, room.sockets['p2']);
  eq(eng.players.length, 2, 'lobby drop: seat freed');
  const st = room.owner.lastOfType('state');
  ok(st && st.pub.players.length === 2, 'lobby drop: survivors get a refreshed roster');
}

// ===========================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
