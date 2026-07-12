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
  screen: 'home',        // home | connecting | room | hostleft | error | duplicate
  dupBusy: false,        // duplicate screen: takeover handoff in progress
  me: null,              // { id, name, isHost, clientId }
  code: '',
  pub: null,             // engine.publicState()
  priv: null,            // engine.privateStateFor(me.id)
  netStatus: 'online',   // online | reconnecting
  netError: '',          // set when the broker/handshake is unreachable
  netGaveUp: false,      // true once we've exhausted automatic reconnect tries
  netNextRetryAt: 0,     // epoch ms of the next scheduled reconnect attempt
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
let reconnectTries = 0; // consecutive automatic reconnect attempts so far
let toastTimer = null;
let turnTimer = null;   // host only: fires when a describe turn's time is up
let tabChannel = null;    // BroadcastChannel for cross-tab takeover coordination
let releaseTabLock = null; // call to give up this tab's exclusive lock

// Reconnect backoff: start gentle, double each miss, cap the wait, and stop
// after a bounded number of tries so a permanently-down broker doesn't spin
// (and hammer the server) forever. A manual "Try again" resets the budget.
const RECONNECT_MAX_TRIES = 6;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 20000;

// Delay before the next attempt: exponential in `tries`, capped, then jittered
// by ±20% so a whole room that dropped together doesn't retry in lockstep and
// stampede the broker. `tries` of 0 means the very first attempt.
function reconnectDelay(tries) {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, tries - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

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
    onNetStatus: (s) => {
      app.netStatus = s === 'online' ? 'online' : 'reconnecting';
      if (s === 'online') { app.netError = ''; app.netGaveUp = false; app.netNextRetryAt = 0; reconnectTries = 0; }
      draw();
    },
    onOpen: () => {
      app.screen = 'room';
      app.netStatus = 'online';
      app.netError = '';
      app.netGaveUp = false;
      app.netNextRetryAt = 0;
      reconnectTries = 0;
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
  if (isRecoverableError(err)) {
    app.netStatus = 'reconnecting';
    app.netError = describePeerError(err);
    scheduleReconnect();
    draw();
    return;
  }
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
    onNetStatus: (s) => {
      app.netStatus = s === 'online' ? 'online' : 'reconnecting';
      if (s === 'online') { app.netError = ''; app.netGaveUp = false; app.netNextRetryAt = 0; reconnectTries = 0; }
      draw();
    },
    onOpen: () => {
      app.netStatus = 'online';
      app.netError = '';
      app.netGaveUp = false;
      app.netNextRetryAt = 0;
      reconnectTries = 0;
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
      app.netError = '';
      app.netGaveUp = false;
      app.netNextRetryAt = 0;
      reconnectTries = 0;
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
  if (isRecoverableError(err)) {
    app.netStatus = 'reconnecting';
    app.netError = describePeerError(err);
    scheduleReconnect();
    draw();
    return;
  }
  app.error = describePeerError(err);
  app.screen = app.pub ? 'hostleft' : 'error';
  draw();
}

// Keep trying to re-reach the broker with exponential backoff. Works for both
// roles: the host retries on its room-code peer, a client on its anonymous peer.
// If PeerJS has torn the peer down entirely (it can't be reconnect()-ed), rebuild
// it from scratch. After RECONNECT_MAX_TRIES we stop and let the UI offer a
// manual retry, rather than spinning (and hammering the server) indefinitely.
function scheduleReconnect() {
  if (reconnectTimer) return;

  const schedule = () => {
    const delay = reconnectDelay(reconnectTries);
    app.netNextRetryAt = Date.now() + delay;
    reconnectTimer = setTimeout(attempt, delay);
  };

  const attempt = () => {
    reconnectTimer = null;
    const amHost = !!(app.me && app.me.isHost);
    const t = amHost ? host : client;
    if (!t) return;

    if (t.isOpen()) {
      reconnectTries = 0;
      app.netStatus = 'online'; app.netError = ''; app.netGaveUp = false;
      app.netNextRetryAt = 0;
      draw();
      return;
    }

    if (reconnectTries >= RECONNECT_MAX_TRIES) {
      // Broker looks genuinely unreachable — stop the automatic loop and hand
      // the user a manual retry / exit instead of an endless silent spinner.
      app.netStatus = 'reconnecting';
      app.netGaveUp = true;
      app.netNextRetryAt = 0;
      draw();
      return;
    }

    reconnectTries += 1;
    if (t.isDestroyed && t.isDestroyed()) {
      if (amHost) startHost(app.code, engine ? engine.serialize() : loadEngineSnapshot());
      else startJoin(app.code);
    } else {
      try { t.reconnect(); } catch (_) {}
    }

    schedule();
  };

  schedule();
}

// ---------------------------------------------------------------------------
// Teardown / navigation
// ---------------------------------------------------------------------------
function teardown() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectTries = 0;
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
  app.netError = '';
  app.netGaveUp = false;
  app.netNextRetryAt = 0;
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
  retryNow: () => {
    // A manual retry gets a fresh budget and restarts the backoff loop.
    reconnectTries = 0;
    app.netGaveUp = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const t = app.me && app.me.isHost ? host : client;
    if (t) { try { t.reconnect(); } catch (_) {} }
    scheduleReconnect();
    draw();
  },
  useHere: () => {
    // Take over the device from the other tab: nudge it to stand down, then
    // block until its lock frees before resuming here. If the resumed session
    // is a host, the peer re-creates from the engine snapshot, so the game
    // survives the handoff (a short settle lets the broker free the room id).
    if (app.dupBusy) return;
    app.dupBusy = true;
    draw();
    if (tabChannel) { try { tabChannel.postMessage('takeover'); } catch (_) {} }
    acquireTabLock({ wait: true }).then((held) => {
      if (held) setTimeout(resumeOrHome, 500);
    });
  },
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
// Single-tab guard. Two tabs in the same browser share one clientId, so a
// second tab would silently steal the first's seat (the host adopts the newest
// connection for a given clientId). We hold an exclusive lock for this tab's
// lifetime; a second tab can't get it and shows a "already open" screen. A
// reload releases the lock instantly, so this never interferes with reconnects.
// ---------------------------------------------------------------------------
const TAB_LOCK = 'localundercover.tab';

function initTabChannel() {
  if (tabChannel || typeof BroadcastChannel === 'undefined') return;
  try {
    tabChannel = new BroadcastChannel('localundercover.tabs');
    tabChannel.onmessage = (e) => {
      // Another tab is taking over this device — stand down so only one tab
      // ever talks to the game at a time.
      if (e.data === 'takeover' && releaseTabLock) {
        teardown();
        releaseTabLock(); releaseTabLock = null;
        app.screen = 'duplicate';
        app.dupBusy = false;
        draw();
      }
    };
  } catch (_) { tabChannel = null; }
}

// Resolves true if we hold the exclusive lock, false if another tab has it.
// With { wait: true } it blocks until the lock is free instead of giving up.
function acquireTabLock({ wait = false } = {}) {
  return new Promise((resolve) => {
    if (!navigator.locks || !navigator.locks.request) { resolve(true); return; }
    const opts = wait ? {} : { ifAvailable: true };
    navigator.locks.request(TAB_LOCK, opts, (lock) => {
      if (!lock) { resolve(false); return; }        // held elsewhere (ifAvailable)
      resolve(true);
      return new Promise((release) => { releaseTabLock = release; }); // hold it
    }).catch(() => resolve(true));                   // API hiccup: don't block play
  });
}

// Resume a prior session if one is still fresh, else land on home.
function resumeOrHome() {
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

async function boot() {
  initTabChannel();
  const held = await acquireTabLock();
  if (!held) { app.screen = 'duplicate'; draw(); return; }
  resumeOrHome();
}

boot();
