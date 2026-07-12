// ============================================================================
// main.js — application controller. Ties together three layers that never talk
// to each other directly:
//   - state.js  the host-authoritative GameEngine (only the host owns one).
//   - net.js    the PeerJS star transport (host or client).
//   - ui.js     the pure render(root, app, intents) view.
//
// Data flow:
//   client UI  --intent-->  client.send(msg)  ==wire==>  host.onData
//   host applies msg to the engine, then hostSync() re-projects state and
//   broadcasts a personalised {pub, priv} snapshot to every peer + itself.
// The host is the single source of truth; clients only render what they're told.
// ============================================================================

import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode, loadClientId,
  saveSession, loadSession, clearSession,
  saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';
import { GameEngine, PHASES } from './state.js';
import {
  createHost, joinHost, isRecoverableError, describePeerError,
} from './net.js';
import { render } from './ui.js';

const HOST_ID = 'host';
const root = document.getElementById('app');
const clientId = loadClientId();

// ---------------------------------------------------------------------------
// Controller state (owned here, rendered by ui.js).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',        // home | connecting | room | hostleft | error
  me: null,              // { id, name, isHost, clientId }
  code: '',
  pub: null,             // engine.publicState()
  priv: null,            // engine.privateStateFor(me.id)
  netStatus: 'online',   // online | reconnecting
  error: '',
  toast: '',
  nameInput: loadName(),
  codeInput: loadCode(),
  showRules: false,
};

let engine = null;   // host only
let host = null;      // createHost(...) result (host transport)
let client = null;    // joinHost(...) result (client transport)
let reconnectTimer = null;
let toastTimer = null;
let turnTimer = null;   // host only: fires when a describe turn's time is up

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function draw() { render(root, app, intents); }

function showToast(msg) {
  app.toast = msg;
  draw();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { app.toast = ''; draw(); }, 2600);
}

// ---------------------------------------------------------------------------
// Host engine intents. `actorId` is the engine id of whoever asked: HOST_ID
// for the host's own UI, or a connection id for a remote client's message.
// Every method returns { ok, error? } straight from the engine's validation.
// ---------------------------------------------------------------------------
function applyHostIntent(actorId, msg) {
  if (!engine) return { ok: false, error: 'No game in progress.' };
  switch (msg.type) {
    case 'join':
      return engine.addPlayer({ id: actorId, name: msg.name, clientId: msg.clientId });
    case 'config':
      return engine.setConfig(actorId, msg);
    case 'start':
      return engine.startGame(actorId);
    case 'kick': {
      const r = engine.kickPlayer(actorId, msg.target);
      if (r.ok && host) {
        host.sendTo(msg.target, { type: 'kicked' });
        const c = host.connections.get(msg.target);
        if (c) { try { c.close(); } catch (_) {} }
      }
      return r;
    }
    case 'ready':         return engine.setReady(actorId);
    case 'beginDescribe': return engine.beginDescribe(actorId);
    case 'advance':       return engine.advanceSpeaker(actorId);
    case 'vote':          return engine.castVote(actorId, msg.target);
    case 'forceResolve':  return engine.forceResolveVote(actorId);
    case 'continue':      return engine.continueAfterReveal(actorId);
    case 'guess':         return engine.submitWhiteGuess(actorId, msg.text);
    case 'skipGuess':     return engine.skipWhiteGuess(actorId);
    case 'playAgain':     return engine.playAgain(actorId);
    case 'leave':         engine.markOffline(actorId); return { ok: true };
    default:              return { ok: false, error: 'Unknown action.' };
  }
}

// Route a UI intent: the host applies it locally; a client ships it upstream.
function act(msg) {
  if (app.me && app.me.isHost) {
    const res = applyHostIntent(app.me.id, msg);
    if (res && res.ok === false && res.error) showToast(res.error);
    hostSync();
  } else if (client) {
    client.send(msg);
  }
}

// Host: recompute snapshots, redraw self, push personalised state to everyone.
function hostSync() {
  if (!engine || !host) return;
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
  draw();
  for (const connId of host.connections.keys()) {
    host.sendTo(connId, { type: 'state', pub: app.pub, priv: engine.privateStateFor(connId) });
  }
  saveEngineSnapshot(engine.serialize());
  scheduleTurnTimer();
}

// Host-only: when the per-turn timer is on, auto-advance the current speaker the
// moment their time runs out. The speaker (or host) can still advance early;
// each redraw reschedules for whatever turn is now current.
function scheduleTurnTimer() {
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  if (!engine || !app.me || !app.me.isHost) return;
  const d = app.pub && app.pub.phase === PHASES.DESCRIBE ? app.pub.describe : null;
  if (!d || !d.endsAt) return;
  const fire = () => {
    turnTimer = null;
    const p = engine.publicState();
    if (p.phase === PHASES.DESCRIBE && p.describe && p.describe.endsAt
        && Date.now() >= p.describe.endsAt - 200) {
      applyHostIntent(app.me.id, { type: 'advance' });
      hostSync();
    } else {
      scheduleTurnTimer(); // clock moved on (e.g. resumed); re-arm
    }
  };
  turnTimer = setTimeout(fire, Math.max(0, d.endsAt - Date.now()));
}

// ---------------------------------------------------------------------------
// HOST bootstrap
// ---------------------------------------------------------------------------
function startHost(code, snap) {
  app.me = { id: HOST_ID, name: app.nameInput, isHost: true, clientId };
  app.code = code;
  app.screen = 'connecting';
  app.error = '';

  engine = new GameEngine();
  if (snap) { try { engine.restore(snap); } catch (_) { engine = new GameEngine(); } }

  const seat = engine.getPlayer(HOST_ID);
  if (!seat) engine.addPlayer({ id: HOST_ID, name: app.nameInput, clientId, isHost: true });
  else { seat.online = true; seat.name = app.nameInput; }

  host = createHost(code, {
    onNetStatus: (s) => { app.netStatus = s === 'online' ? 'online' : 'reconnecting'; draw(); },
    onOpen: () => {
      app.screen = 'room';
      app.netStatus = 'online';
      saveSession({ role: 'host', code, name: app.nameInput });
      hostSync();
    },
    onConnect: (connId) => {
      host.sendTo(connId, { type: 'welcome', id: connId });
      hostSync();
    },
    onData: (connId, msg) => {
      const res = applyHostIntent(connId, msg);
      if (res && res.ok === false && res.error) {
        host.sendTo(connId, {
          type: msg.type === 'join' ? 'error' : 'rejected',
          message: res.error,
        });
      }
      hostSync();
    },
    onDisconnect: (connId) => { if (engine) engine.markOffline(connId); hostSync(); },
    onError: (err) => handleHostError(err),
  });

  draw();
}

function handleHostError(err) {
  if (isRecoverableError(err)) { app.netStatus = 'reconnecting'; draw(); return; }
  app.error = describePeerError(err);
  app.screen = 'error';
  draw();
}

// ---------------------------------------------------------------------------
// CLIENT bootstrap
// ---------------------------------------------------------------------------
function startJoin(code) {
  app.me = { id: null, name: app.nameInput, isHost: false, clientId };
  app.code = code;
  app.screen = 'connecting';
  app.error = '';

  client = joinHost(code, {
    onNetStatus: (s) => { app.netStatus = s === 'online' ? 'online' : 'reconnecting'; draw(); },
    onOpen: () => {
      app.netStatus = 'online';
      client.send({ type: 'join', name: app.nameInput, clientId });
      draw();
    },
    onData: (msg) => handleClientMessage(msg),
    onClose: () => { app.netStatus = 'reconnecting'; scheduleReconnect(); draw(); },
    onError: (err) => handleClientError(err),
  });

  draw();
}

function handleClientMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'welcome':
      if (app.me) app.me.id = msg.id;
      break;
    case 'state':
      app.screen = 'room';
      app.netStatus = 'online';
      app.pub = msg.pub;
      app.priv = msg.priv;
      if (app.me && msg.priv && msg.priv.id) app.me.id = msg.priv.id;
      saveSession({ role: 'client', code: app.code, name: app.nameInput });
      draw();
      break;
    case 'rejected':
      showToast(msg.message);
      break;
    case 'kicked':
      teardown();
      clearSession();
      app.screen = 'hostleft';
      app.error = 'The host removed you from the game.';
      draw();
      break;
    case 'error':
      app.error = msg.message || 'The game ended.';
      app.screen = app.pub ? 'hostleft' : 'error';
      draw();
      break;
    default:
      break;
  }
}

function handleClientError(err) {
  if (isRecoverableError(err)) { app.netStatus = 'reconnecting'; scheduleReconnect(); draw(); return; }
  app.error = describePeerError(err);
  app.screen = app.pub ? 'hostleft' : 'error';
  draw();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (!client) { clearInterval(reconnectTimer); reconnectTimer = null; return; }
    if (client.isOpen()) {
      clearInterval(reconnectTimer); reconnectTimer = null;
      app.netStatus = 'online'; draw();
      return;
    }
    try { client.reconnect(); } catch (_) {}
  }, 2500);
}

// ---------------------------------------------------------------------------
// Teardown / navigation
// ---------------------------------------------------------------------------
function teardown() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  if (host) { try { host.destroy(); } catch (_) {} host = null; }
  if (client) { try { client.destroy(); } catch (_) {} client = null; }
  engine = null;
}

function resetToHome() {
  app.screen = 'home';
  app.me = null;
  app.pub = null;
  app.priv = null;
  app.code = '';
  app.netStatus = 'online';
  app.error = '';
  draw();
}

function leave() {
  if (app.me && app.me.isHost && host) {
    host.broadcast({ type: 'error', message: 'The host ended the game.' });
  } else if (client) {
    try { client.send({ type: 'leave' }); } catch (_) {}
  }
  teardown();
  clearSession();
  resetToHome();
}

function goHome() {
  teardown();
  clearSession();
  resetToHome();
}

// ---------------------------------------------------------------------------
// Home actions
// ---------------------------------------------------------------------------
function doHost() {
  const name = (app.nameInput || '').trim();
  if (!name) { app.error = 'Enter your name first.'; draw(); return; }
  saveName(name);
  const code = generateRoomCode();
  saveCode(code);
  startHost(code, null);
}

function doJoin() {
  const name = (app.nameInput || '').trim();
  const code = normalizeCode(app.codeInput || '');
  if (!name) { app.error = 'Enter your name first.'; draw(); return; }
  if (code.length !== 4) { app.error = 'Enter the 4-letter room code.'; draw(); return; }
  saveName(name);
  saveCode(code);
  startJoin(code);
}

async function copyCode() {
  const ok = await copyText(app.code);
  showToast(ok ? 'Code copied' : app.code);
}

// A join link carries the room code so friends skip typing it: they land on
// the home screen with the code pre-filled and just add their name.
function inviteLink(code) {
  return location.origin + location.pathname + '?code=' + encodeURIComponent(code);
}

async function shareLink() {
  if (!app.code) return;
  const url = inviteLink(app.code);
  const data = { title: 'Undercover', text: `Join my Undercover game — code ${app.code}`, url };
  if (navigator.share) {
    try { await navigator.share(data); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* else fall back to copy */ }
  }
  const ok = await copyText(url);
  showToast(ok ? 'Invite link copied' : url);
}

// Read a room code from ?code=… (or a #code=… / #CODE hash), then scrub it from
// the address bar so a later "Create game" doesn't inherit a stale code.
function readCodeFromUrl() {
  try {
    let raw = new URLSearchParams(location.search).get('code') || '';
    if (!raw && location.hash) {
      const h = location.hash.slice(1);
      raw = h.startsWith('code=') ? h.slice(5) : h;
    }
    const code = normalizeCode(raw);
    if (code) { try { history.replaceState(null, '', location.pathname); } catch (_) {} }
    return code;
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Intents handed to ui.js
// ---------------------------------------------------------------------------
const intents = {
  setName: (v) => { app.nameInput = v; saveName(v); },
  setCode: (v) => { app.codeInput = v; },
  host: doHost,
  join: doJoin,
  goHome,
  leave,
  showRules: () => { app.showRules = true; draw(); },
  hideRules: () => { app.showRules = false; draw(); },
  copyCode,
  shareLink,

  // lobby / config (host)
  setCategory: (id) => act({ type: 'config', category: id }),
  setUndercover: (n) => act({ type: 'config', undercover: n }),
  setMrWhite: (b) => act({ type: 'config', mrwhite: b }),
  setTieBreak: (m) => act({ type: 'config', tieBreak: m }),
  setTimer: (b) => act({ type: 'config', timer: b }),
  setTimerSeconds: (n) => act({ type: 'config', timerSeconds: n }),
  startGame: () => act({ type: 'start' }),
  kick: (id) => act({ type: 'kick', target: id }),

  // in-game
  ready: () => act({ type: 'ready' }),
  beginDescribe: () => act({ type: 'beginDescribe' }),
  doneSpeaking: () => act({ type: 'advance' }),
  vote: (id) => act({ type: 'vote', target: id }),
  forceResolve: () => act({ type: 'forceResolve' }),
  continueReveal: () => act({ type: 'continue' }),
  submitGuess: (text) => act({ type: 'guess', text }),
  skipGuess: () => act({ type: 'skipGuess' }),
  playAgain: () => act({ type: 'playAgain' }),
};

// ---------------------------------------------------------------------------
// Boot — resume a prior session if one is still fresh.
// ---------------------------------------------------------------------------
function boot() {
  const s = loadSession();
  if (s && s.code && s.name) {
    app.nameInput = s.name;
    if (s.role === 'host') { startHost(s.code, loadEngineSnapshot()); return; }
    startJoin(s.code);
    return;
  }
  const linkCode = readCodeFromUrl();
  if (linkCode) app.codeInput = linkCode;
  draw();
}

boot();
