// ============================================================================
// ui.js — pure view layer. render(root, app, intents) is the single entry.
//
// Given the controller's `app` state (screen + latest public/private snapshots)
// and an `intents` map of callbacks, it rebuilds the DOM. It never touches the
// network or the engine directly.
// ============================================================================

import { el, clear } from './util.js';
import {
  PHASES, TIE_BREAK, TIMER, MIN_PLAYERS, MAX_PLAYERS, maxUndercover, describeRole,
} from './rules.js';
import { categoryOptions } from './words.js';
import { serverConfigured } from './config.js';

let _lastKey = '';
let _ticker = null; // active countdown interval (only one alive at a time)

const TIE_LABELS = {
  [TIE_BREAK.RUNOFF]: 'Runoff',
  [TIE_BREAK.RUNOFF_RANDOM]: 'Runoff → random',
  [TIE_BREAK.NONE]: 'No elimination',
};

export function render(root, app, intents) {
  clear(root);
  if (_ticker) { clearInterval(_ticker); _ticker = null; } // stop any old countdown

  const key = app.screen + ':' + (app.pub ? app.pub.phase : '');
  const shell = el('div', { class: 'shell' });

  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'connecting': node = connectingScreen(app, intents); break;
    case 'duplicate':  node = duplicateScreen(app, intents); break;
    case 'room':       node = roomScreen(app, intents); break;
    case 'hostleft':   node = messageScreen('Disconnected', app.error || 'The game ended.', intents); break;
    case 'error':      node = messageScreen('Something went wrong', app.error || 'Unknown error.', intents); break;
    default:           node = homeScreen(app, intents);
  }
  shell.appendChild(node);

  if (key !== _lastKey) { shell.classList.add('screen-enter'); _lastKey = key; }
  root.appendChild(shell);

  // Overlays. The connecting screen already spells out the reconnect state, so
  // the floating banner would just be noise there.
  if (app.netStatus === 'reconnecting' && app.screen !== 'connecting') {
    // Once auto-retry has given up, make the banner an actionable retry rather
    // than a spinner that never resolves.
    root.appendChild(app.netGaveUp
      ? el('div', { class: 'net-banner net-banner-stuck', onclick: () => intents.retryNow() },
          "Can't reconnect — tap to try again")
      : el('div', { class: 'net-banner' }, 'Reconnecting…'));
  }
  if (app.showRules) root.appendChild(rulesModal(intents));
  root.appendChild(peekOverlay(app));
  root.appendChild(toastEl(app));

  // Tell screen readers what just changed (whose turn, vote, elimination, result).
  announce(announcementFor(app));
}

// ---------------------------------------------------------------------------
// Screen-reader announcements (aria-live)
// ---------------------------------------------------------------------------
// One visually-hidden polite live region, created once and kept OUTSIDE the
// re-rendered root so it survives every clear()/rebuild — SRs only announce
// changes to a region that stays in the DOM. render() recomputes a short
// summary of the current phase each draw; announce() speaks it only when it
// actually changes, so countdown ticks and re-renders don't cause chatter.
let _liveRegion = null;
let _lastAnnounce = '';

function announce(msg) {
  if (typeof document === 'undefined' || !msg || msg === _lastAnnounce) return;
  _lastAnnounce = msg;
  if (!_liveRegion) {
    _liveRegion = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.appendChild(_liveRegion);
  }
  _liveRegion.textContent = msg;
}

// Pure map from game state to one screen-reader sentence (or '' for silence).
// Exported for unit testing; keeps no DOM dependency so it runs under Node.
export function announcementFor(app) {
  if (!app || app.screen !== 'room' || !app.pub) return '';
  const pub = app.pub;
  const priv = app.priv;
  const nameOf = (id) => {
    const p = (pub.players || []).find((x) => x.id === id);
    return p ? p.name : 'Someone';
  };

  switch (pub.phase) {
    case PHASES.ROLE_REVEAL:
      return 'Roles are dealt. Hold your card to reveal your secret word, then tap Ready.';
    case PHASES.DESCRIBE:
      if (priv && priv.isMyTurn) return 'Your turn to describe. Give one clue about your word.';
      return `${nameOf(pub.describe && pub.describe.currentSpeakerId)}’s turn to describe.`;
    case PHASES.VOTE:
      return (pub.vote && pub.vote.isRunoff)
        ? 'Runoff vote. Vote again between the tied players.'
        : 'Time to vote. Choose one player to eliminate.';
    case PHASES.REVEAL: {
      const r = pub.reveal;
      if (!r || r.type === 'none' || !r.eliminated) return 'The vote was tied. Nobody is eliminated this round.';
      return `${r.eliminated.name} is out. They were ${describeRole(r.eliminated.role).name}.`;
    }
    case PHASES.WHITE_GUESS:
      if (priv && priv.isGuesser) return 'Your last shot. Guess the civilians’ word to steal the win.';
      return `${(pub.whiteGuess && pub.whiteGuess.whiteName) || 'Mr. White'} is guessing the civilians’ word.`;
    case PHASES.GAMEOVER: {
      const f = pub.final || {};
      const title = f.winner === 'civilians' ? 'Civilians win'
        : f.winner === 'mrwhite' ? 'Mr. White wins'
        : 'Impostors win';
      return f.reason ? `${title}. ${f.reason}` : `${title}.`;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function homeScreen(app, intents) {
  const wrap = el('div', { class: 'field-group' });
  // Arrived via an invite link (?code=…): surface a prominent one-tap join and
  // demote the usual "Create game" / manual-join controls.
  const invited = app.invited && !!app.codeInput;

  wrap.appendChild(el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }), 'LOCAL · SAME WI-FI · 4–20 PLAYERS'));
  wrap.appendChild(el('h1', { class: 'hero' }, 'Under', el('span', { class: 'accent' }, 'cover')));
  wrap.appendChild(el('p', { class: 'tagline' },
    'A social word-deduction game for your group. One phone each, one host, no app store.'));

  const nameField = el('input', {
    class: 'field', type: 'text', maxlength: 14, placeholder: 'e.g. Aria',
    value: app.nameInput || '', autocomplete: 'off',
    oninput: (e) => intents.setName(e.target.value),
  });
  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Your name'), nameField));

  // Invite landing: a highlighted, pre-filled join for the room in the link.
  if (invited) {
    wrap.appendChild(el('div', { class: 'card', style: 'border-color:var(--accent)' },
      el('div', { class: 'card-label accent' }, "You're invited"),
      el('div', { class: 'room-code' }, app.codeInput),
      el('button', {
        class: 'btn btn-primary btn-block', onclick: () => intents.join(),
      }, 'Join game')));
    // Escape hatch: drop the pre-filled code and reveal manual entry.
    wrap.appendChild(el('button', {
      class: 'link-btn', onclick: () => intents.clearInvite(),
    }, 'Join a different game'));
  }

  wrap.appendChild(el('button', {
    class: 'btn btn-block ' + (invited ? 'btn-secondary' : 'btn-primary'),
    onclick: () => intents.host(),
  }, 'Create game'));

  // Server reachability, mirroring the in-room transport badge. Shown only when a
  // server is configured at all; a pure peer-to-peer build renders nothing here.
  if (serverConfigured()) {
    const online = app.serverProbe === 'online';
    const pending = app.serverProbe === 'pending';
    const label = online ? 'Server online' : pending ? 'Checking server…' : 'Server offline';
    const pill = el('span', {
      class: 'pill' + (online ? ' accent' : ''),
      style: 'cursor:pointer',
      onclick: () => intents.recheckServer(),
      title: pending
        ? 'Checking whether the game server is reachable…'
        : online
          ? 'The game server is reachable — you can host a room players join from anywhere. Tap to re-check.'
          : 'The game server is unreachable right now — only same-Wi-Fi games are available. Tap to re-check.',
    }, label, pending ? null : el('span', { style: 'opacity:0.7' }, '↻'));
    wrap.appendChild(el('div', { style: 'display:flex;justify-content:center' }, pill));
  }

  // Offered only when the game server answered its health probe. Peer-to-peer
  // stays the default (works offline on one Wi-Fi); the server lets players on
  // different networks join the same room.
  if (app.serverAvailable) {
    wrap.appendChild(el('button', {
      class: 'btn btn-secondary btn-block', onclick: () => intents.hostServer(),
    }, 'Host on server'));
    wrap.appendChild(el('p', { class: 'fine', style: 'text-align:center' },
      'Create game = same Wi-Fi, works offline. Host on server = friends can join from anywhere.'));
  }

  // Manual code entry — redundant once an invite link has pre-filled the room.
  if (!invited) {
    const codeField = el('input', {
      class: 'field field-code', type: 'text', maxlength: 4, placeholder: 'CODE',
      value: app.codeInput || '', autocomplete: 'off', autocapitalize: 'characters',
      oninput: (e) => intents.setCode(e.target.value),
    });
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Join a game'),
      codeField,
      el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.join() }, 'Join')));
  }

  if (app.error) wrap.appendChild(el('p', { class: 'error-text' }, app.error));

  wrap.appendChild(el('button', { class: 'link-btn', onclick: () => intents.showRules() }, 'How to play'));
  wrap.appendChild(el('p', { class: 'fine' },
    'Peer-to-peer over your local network · no accounts · ',
    el('a', { href: 'https://github.com/IamYVJ/localundercover', target: '_blank', rel: 'noopener' }, 'source')));
  return wrap;
}

function connectingScreen(app, intents) {
  const amHost = app.me && app.me.isHost;
  // Broker unreachable during the first handshake: give feedback + an escape,
  // rather than an indefinite "Joining…" that looks frozen.
  if (app.netError) {
    return el('div', { class: 'field-group' },
      el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }),
        app.netGaveUp ? 'OFFLINE' : 'RECONNECTING'),
      el('h1', { class: 'hero hero-sm' }, "Can't reach the server"),
      el('p', { class: 'tagline' }, app.netError),
      app.netGaveUp
        ? el('p', { class: 'fine' }, 'Gave up after several tries — check your connection, then try again.')
        : retryCountdownEl(app),
      intents && intents.retryNow
        ? el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.retryNow() }, 'Try again now')
        : null,
      intents && intents.goHome
        ? el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.goHome() }, 'Back to start')
        : null);
  }
  // Server owner: the room code is minted by the server, so there's nothing to
  // show until the first reply arrives — say what's happening meanwhile.
  if (amHost && app.mode === 'server' && !app.code) {
    return el('div', { class: 'field-group' },
      el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), 'HOSTING'),
      el('h1', { class: 'hero hero-sm' }, 'Creating room…'),
      el('p', { class: 'tagline' }, 'Reserving a room on the game server.'));
  }
  // Host: surface the room code now so it can be shared while the first
  // handshake is still in flight — players can join the moment it connects.
  if (amHost && app.code) {
    return el('div', { class: 'field-group' },
      el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), 'ROOM CODE'),
      el('div', {
        class: 'room-code', onclick: () => intents.copyCode(), title: 'Tap to copy',
      }, app.code),
      el('p', { class: 'tagline' }, 'Opening room…'),
      el('p', { class: 'fine', style: 'text-align:center' },
        'Reaching the connection server. Share the code now — friends can join the moment it connects.'),
      intents && intents.shareLink
        ? el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.shareLink() }, 'Share invite link')
        : null);
  }

  return el('div', { class: 'field-group' },
    el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), 'CONNECTING'),
    el('h1', { class: 'hero hero-sm' }, 'Joining…'),
    el('p', { class: 'tagline' }, 'Reaching the connection server for the first handshake.'));
}

// Live "retrying in Ns…" line for the connecting screen. Reads the controller's
// next-retry timestamp on each tick so it stays in step with the backoff even
// when main.js reschedules without a re-render. Reuses the single _ticker (the
// turn timer is never on screen at the same time).
function retryCountdownEl(app) {
  const p = el('p', { class: 'fine' }, '');
  const tick = () => {
    const remaining = app.netNextRetryAt ? app.netNextRetryAt - Date.now() : 0;
    p.textContent = remaining > 0 ? `Retrying in ${Math.ceil(remaining / 1000)}s…` : 'Retrying…';
  };
  tick();
  if (_ticker) { clearInterval(_ticker); _ticker = null; }
  _ticker = setInterval(tick, 250);
  return p;
}

// Shown when this device already has the game open in another tab. Two tabs
// share one clientId and would fight over the same seat, so only one runs.
function duplicateScreen(app, intents) {
  return el('div', { class: 'field-group' },
    el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), 'ALREADY OPEN'),
    el('h1', { class: 'hero hero-sm' }, 'Open in another tab'),
    el('p', { class: 'tagline' },
      'Undercover is already running in another tab or window on this device — two at once would clash.'),
    el('p', { class: 'fine', style: 'text-align:center' },
      'Switch back to that tab to keep playing, or take over here (the other tab will stand down).'),
    el('button', {
      class: 'btn btn-primary btn-block',
      disabled: app.dupBusy,
      onclick: () => intents.useHere(),
    }, app.dupBusy ? 'Taking over…' : 'Use this tab instead'));
}

function messageScreen(title, body, intents) {
  return el('div', { class: 'field-group' },
    el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), 'UNDERCOVER'),
    el('h1', { class: 'hero hero-sm' }, title),
    el('p', { class: 'tagline' }, body),
    el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.goHome() }, 'Back to start'));
}

// ---------------------------------------------------------------------------
// ROOM — dispatch by phase
// ---------------------------------------------------------------------------
function roomScreen(app, intents) {
  const pub = app.pub;
  if (!pub) return connectingScreen(app, intents);
  switch (pub.phase) {
    case PHASES.LOBBY:       return lobbyScreen(app, intents);
    case PHASES.ROLE_REVEAL: return roleRevealScreen(app, intents);
    case PHASES.DESCRIBE:    return describeScreen(app, intents);
    case PHASES.VOTE:        return voteScreen(app, intents);
    case PHASES.REVEAL:      return eliminationScreen(app, intents);
    case PHASES.WHITE_GUESS: return whiteGuessScreen(app, intents);
    case PHASES.GAMEOVER:    return gameoverScreen(app, intents);
    default:                 return connectingScreen(app, intents);
  }
}

// A small pill naming which transport the room is running on. Only meaningful
// when a server is even configured — otherwise the app is pure peer-to-peer and
// there's nothing to contrast, so we render nothing and the P2P-only UI is
// unchanged. Returns null (which el() skips as a child) when there's no server.
function transportBadge(app) {
  if (!serverConfigured()) return null;
  const onServer = app.mode === 'server';
  return el('span', {
    class: 'pill' + (onServer ? ' accent' : ''),
    title: onServer
      ? 'Hosted on the game server — players can join from anywhere.'
      : 'Local peer-to-peer over your Wi-Fi.',
  }, onServer ? 'On server' : 'LAN');
}

function roomHeader(app, kicker) {
  return el('div', {},
    el('div', { class: 'wordmark' },
      el('span', { class: 'wordmark-dot' }),
      kicker || 'UNDERCOVER',
      el('span', { style: 'margin-left:auto;display:inline-flex;align-items:center;gap:9px' },
        transportBadge(app),
        el('span', { style: 'color:var(--accent)' }, 'ROOM ' + app.code))));
}

function isHost(app) { return app.me && app.me.isHost; }

// ---------------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------------
function lobbyScreen(app, intents) {
  const pub = app.pub;
  const host = isHost(app);
  const n = pub.players.length;
  const wrap = el('div', { class: 'field-group' });

  const badge = transportBadge(app);
  wrap.appendChild(el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }), 'ROOM CODE',
    badge ? el('span', { style: 'margin-left:auto' }, badge) : null));
  wrap.appendChild(el('div', {
    class: 'room-code', onclick: () => intents.copyCode(),
    title: 'Tap to copy',
  }, app.code || '····'));
  wrap.appendChild(el('p', { class: 'fine', style: 'text-align:center' },
    app.mode === 'server'
      ? 'Share this code. Players can join from anywhere. Tap the code to copy.'
      : 'Share this code. Everyone joins on the same Wi-Fi. Tap the code to copy.'));
  wrap.appendChild(el('button', {
    class: 'btn btn-secondary btn-block', onclick: () => intents.shareLink(),
  }, 'Share invite link'));

  // Roster.
  const list = el('ul', { class: 'player-list' });
  pub.players.forEach((p) => {
    const row = el('li', { class: 'player-row' + (p.online ? '' : ' offline') + (p.id === app.me.id ? ' me' : '') },
      el('span', { class: 'player-dot' + (p.online ? '' : ' off') }),
      el('span', { class: 'pname' }, p.name),
      p.isHost ? el('span', { class: 'pill accent' }, 'Host') : null,
      (host && !p.isHost)
        ? el('button', { class: 'link-btn', onclick: () => intents.kick(p.id) }, 'remove')
        : null);
    list.appendChild(row);
  });
  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, `${n} player${n === 1 ? '' : 's'} in lobby`), list));

  // Config.
  wrap.appendChild(host ? hostConfigCard(app, intents) : guestConfigCard(app));

  // Start / wait.
  if (host) {
    const canStart = pub.lobby.canStart;
    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block' + (canStart ? '' : ' btn-disabled'),
      disabled: !canStart,
      onclick: () => canStart && intents.startGame(),
    }, canStart ? 'Start game' : (n < MIN_PLAYERS ? `Need ${MIN_PLAYERS}+ players` : 'Fix role counts')));
    if (!pub.lobby.valid) wrap.appendChild(el('p', { class: 'error-text' }, pub.lobby.error));
  } else {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Waiting for the host to start…')));
  }

  wrap.appendChild(el('button', { class: 'link-btn', onclick: () => intents.showRules() }, 'How to play'));
  wrap.appendChild(el('button', { class: 'btn btn-ghost btn-block', onclick: () => intents.leave() }, 'Leave'));
  return wrap;
}

function hostConfigCard(app, intents) {
  const pub = app.pub;
  const cfg = pub.config;
  const n = pub.players.length;
  const cats = categoryOptions();

  const select = el('select', {
    class: 'field',
    onchange: (e) => intents.setCategory(e.target.value),
  }, ...cats.map((c) => el('option', { value: c.id, selected: c.id === cfg.category }, `${c.name} (${c.count})`)));

  const ucMax = Math.max(1, maxUndercover(n, cfg.mrwhite));
  const ucVal = Math.min(cfg.undercover, ucMax);
  const stepper = el('div', { class: 'btn-row', style: 'align-items:center' },
    el('button', { class: 'btn btn-secondary', onclick: () => intents.setUndercover(Math.max(1, ucVal - 1)) }, '−'),
    el('div', { style: 'flex:1;text-align:center;font-family:var(--mono);font-size:20px' }, String(ucVal)),
    el('button', { class: 'btn btn-secondary', onclick: () => intents.setUndercover(Math.min(ucMax, ucVal + 1)) }, '+'));

  const whiteToggle = el('button', {
    class: 'btn ' + (cfg.mrwhite ? 'btn-primary' : 'btn-secondary') + ' btn-block',
    onclick: () => intents.setMrWhite(!cfg.mrwhite),
  }, cfg.mrwhite ? 'Mr. White: ON' : 'Mr. White: OFF');

  const tieRow = el('div', { class: 'btn-row' },
    ...Object.values(TIE_BREAK).map((mode) => el('button', {
      class: 'btn ' + (cfg.tieBreak === mode ? 'btn-primary' : 'btn-secondary'),
      style: 'min-width:110px;font-size:12px',
      onclick: () => intents.setTieBreak(mode),
    }, TIE_LABELS[mode])));

  const timerOn = !!cfg.timer;
  const timerToggle = el('button', {
    class: 'btn ' + (timerOn ? 'btn-primary' : 'btn-secondary') + ' btn-block',
    onclick: () => intents.setTimer(!timerOn),
  }, timerOn ? 'Turn timer: ON' : 'Turn timer: OFF');

  let timerSlider = null;
  if (timerOn) {
    const secs = cfg.timerSeconds || TIMER.DEFAULT;
    const readout = el('div', { class: 'slider-readout' }, `${secs}s per turn`);
    const slider = el('input', {
      class: 'slider', type: 'range',
      min: String(TIMER.MIN), max: String(TIMER.MAX), step: String(TIMER.STEP),
      value: String(secs),
      // Live-update the label while dragging; only broadcast on release.
      oninput: (e) => { readout.textContent = `${e.target.value}s per turn`; },
      onchange: (e) => intents.setTimerSeconds(Number(e.target.value)),
    });
    timerSlider = el('div', { class: 'slider-row' }, slider, readout);
  }

  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Word category'), select,
    el('div', { class: 'card-label' }, 'Undercover'), stepper,
    el('div', { class: 'card-label' }, 'Mr. White'), whiteToggle,
    el('div', { class: 'card-label' }, 'Vote-tie rule'), tieRow,
    el('div', { class: 'card-label' }, 'Turn timer'), timerToggle, timerSlider,
    el('p', { class: 'fine' }, roleSummaryText(pub)));
}

function guestConfigCard(app) {
  const pub = app.pub;
  const cat = categoryOptions().find((c) => c.id === pub.config.category);
  const timerText = pub.config.timer ? `${pub.config.timerSeconds}s per turn` : 'off';
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Setup'),
    el('p', { class: 'fine' }, roleSummaryText(pub)),
    el('p', { class: 'fine' }, `Category: ${cat ? cat.name : '—'} · Ties: ${TIE_LABELS[pub.config.tieBreak]}`),
    el('p', { class: 'fine' }, `Turn timer: ${timerText}`));
}

function roleSummaryText(pub) {
  const rc = pub.roleCounts;
  const parts = [`${rc.civilian} civilian${rc.civilian === 1 ? '' : 's'}`, `${rc.undercover} undercover`];
  if (rc.mrwhite) parts.push('1 Mr. White');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// ROLE REVEAL
// ---------------------------------------------------------------------------
function roleRevealScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, 'ROLE REVEAL'));
  wrap.appendChild(el('h1', { class: 'hero hero-sm' }, 'Your secret word'));
  wrap.appendChild(el('p', { class: 'tagline' },
    'Hold the card to peek — keep it hidden from your neighbours. Memorise it, then tap Ready.'));

  wrap.appendChild(holdCard(priv));

  const readyCount = pub.players.filter((p) => p.online).length;
  const notReady = pub.players.filter((p) => p.online);
  // We can't see others' ready flags from public state; show a simple prompt.
  if (priv && priv.ready) {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'You are ready — waiting for others…')));
  } else {
    wrap.appendChild(el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.ready() }, 'I’m ready'));
  }

  if (isHost(app)) {
    wrap.appendChild(el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.beginDescribe() },
      'Skip wait — start describing'));
  }

  wrap.appendChild(el('button', { class: 'link-btn', onclick: () => intents.showRules() }, 'How to play'));
  wrap.appendChild(el('button', { class: 'btn btn-ghost btn-block', onclick: () => intents.leave() }, 'Leave game'));
  return wrap;
}

// A press-and-hold card that reveals the player's role + word.
function holdCard(priv) {
  const card = el('div', {
    class: 'hold-card',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Hold to reveal your secret role and word — or press Enter to toggle.',
  }, el('div', { class: 'hold-hint' }, 'HOLD TO REVEAL'));

  const reveal = el('div', { class: 'hold-reveal' });
  if (priv && priv.role) reveal.appendChild(revealContent(priv));
  card.appendChild(reveal);

  const show = (e) => { if (e) e.preventDefault(); card.classList.add('revealed'); };
  const hide = () => card.classList.remove('revealed');
  card.addEventListener('pointerdown', show);
  card.addEventListener('pointerup', hide);
  card.addEventListener('pointerleave', hide);
  card.addEventListener('pointercancel', hide);
  // Keyboard/switch users can't reliably hold a press: Enter/Space toggles the
  // reveal, and blur re-hides it so the word never lingers once focus moves on.
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      card.classList.toggle('revealed');
    }
  });
  card.addEventListener('blur', hide);
  return card;
}

function revealContent(priv) {
  const color = priv.roleColor || 'civ';
  const wrap = el('div', { class: 'reveal-inner' });
  wrap.appendChild(el('span', { class: 'pill ' + color }, priv.roleName || 'Civilian'));
  if (priv.role === 'mrwhite') {
    wrap.appendChild(el('div', { class: 'secret-word muted-word' }, 'No word'));
    wrap.appendChild(el('p', { class: 'fine', style: 'text-align:center' }, priv.roleBlurb || ''));
  } else {
    wrap.appendChild(el('div', { class: 'secret-word ' + color }, priv.word || '—'));
    wrap.appendChild(el('p', { class: 'fine', style: 'text-align:center' }, priv.roleBlurb || ''));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// DESCRIBE
// ---------------------------------------------------------------------------
function describeScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const d = pub.describe || { order: [], idx: 0, currentSpeakerId: null };
  const current = pub.players.find((p) => p.id === d.currentSpeakerId);
  const myTurn = priv && priv.isMyTurn;

  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, `ROUND ${pub.round} · DESCRIBE`));
  wrap.appendChild(el('h1', { class: 'hero hero-sm' },
    myTurn ? 'Your turn' : ((current ? current.name : '—') + '’s turn')));
  wrap.appendChild(el('p', { class: 'tagline' },
    myTurn
      ? 'Say ONE word or short phrase out loud that hints at your word — don’t say the word itself.'
      : 'Listen. Each player gives one clue about their word, in order.'));

  if (d.endsAt) wrap.appendChild(countdownEl(d.endsAt, d.seconds, myTurn));

  // Speaking order with progress. The host can drop a player who has left or is
  // holding things up — offline seats are flagged so it's clear who to remove.
  const amHost = isHost(app);
  const list = el('ul', { class: 'player-list' });
  d.order.forEach((id, i) => {
    const p = pub.players.find((x) => x.id === id);
    if (!p) return;
    const state = i < d.idx ? 'done' : (i === d.idx ? 'current' : 'pending');
    list.appendChild(el('li', { class: 'player-row' + (p.online ? '' : ' offline') + (id === app.me.id ? ' me' : '') },
      el('span', { class: 'turn-num' + (state === 'current' ? ' now' : '') }, String(i + 1)),
      el('span', { class: 'pname' }, p.name),
      !p.online ? el('span', { class: 'pill' }, 'offline') : null,
      state === 'done' ? el('span', { class: 'pill civ' }, 'spoke')
        : state === 'current' ? el('span', { class: 'pill accent' }, 'speaking') : null,
      (amHost && !p.isHost && id !== app.me.id)
        ? el('button', { class: 'link-btn', onclick: () => intents.kick(id) }, 'remove')
        : null));
  });
  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Speaking order'), list));

  if (myTurn) {
    wrap.appendChild(el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.doneSpeaking() },
      'Done — I’ve given my clue'));
  } else if (isHost(app)) {
    wrap.appendChild(el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.doneSpeaking() },
      `Advance ${current ? current.name : ''} →`));
  } else {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, `Waiting for ${current ? current.name : 'the speaker'}…`)));
  }

  wrap.appendChild(leaveRow(app, intents));
  return wrap;
}

// Synthesized cues so the speaker isn't glued to the screen in the final
// seconds. WebAudio (no asset files, works offline) + haptics where supported.
// Both fail silently — a missing API just means no cue, never a broken turn.
let _audioCtx = null;
function _tone(freq, durationMs, peak) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const now = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.connect(gain).connect(_audioCtx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch (_) { /* no audio — silent is fine */ }
}
function _buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignore */ }
}
// Browsers block audio until a user gesture, so warm the context on the first
// tap/keypress — by the time a turn counts down, cues will actually play.
function _primeAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
  } catch (_) { /* ignore */ }
}
if (typeof window !== 'undefined') {
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, _primeAudio, { passive: true }));
}

// A local countdown to an absolute deadline (endsAt, epoch ms). Ticks via a
// single module-level interval that render() clears on the next redraw.
function countdownEl(endsAt, seconds, myTurn) {
  const total = Math.max(1, (seconds || TIMER.DEFAULT) * 1000);
  const fill = el('div', { class: 'timer-bar-fill' });
  const num = el('span', { class: 'timer-num' }, '');
  const box = el('div', { class: 'timer' + (myTurn ? ' mine' : '') },
    num, el('div', { class: 'timer-bar' }, fill));

  let lastCued = null; // last whole-second we cued (tick fires 4x/sec)
  const tick = () => {
    const remaining = Math.max(0, endsAt - Date.now());
    const secLeft = Math.ceil(remaining / 1000);
    num.textContent = secLeft + 's';
    fill.style.width = Math.max(0, Math.min(100, (remaining / total) * 100)) + '%';
    box.classList.toggle('low', remaining <= 5000);
    // Only the player on the clock is cued — no chorus of buzzing phones.
    if (myTurn && remaining <= 5000 && secLeft > 0 && secLeft !== lastCued) {
      lastCued = secLeft;
      _tone(660, 70, 0.05);
      _buzz(25);
    }
    if (remaining <= 0) {
      if (myTurn && lastCued !== 0) { lastCued = 0; _tone(392, 260, 0.09); _buzz([50, 40, 80]); }
      if (_ticker) { clearInterval(_ticker); _ticker = null; }
    }
  };
  tick();
  _ticker = setInterval(tick, 250);
  return box;
}

// ---------------------------------------------------------------------------
// VOTE
// ---------------------------------------------------------------------------
function voteScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const v = pub.vote || { candidates: [], progress: [], isRunoff: false };
  const iAmAlive = priv && priv.alive;
  // Only connected players are being waited on; offline ones can't vote.
  const waiting = v.progress.filter((x) => x.online !== false);
  const votedCount = waiting.filter((x) => x.voted).length;
  const aliveCount = waiting.length;

  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, `ROUND ${pub.round} · VOTE`));
  wrap.appendChild(el('h1', { class: 'hero hero-sm' }, v.isRunoff ? 'Runoff vote' : 'Who’s the impostor?'));
  wrap.appendChild(el('p', { class: 'tagline' },
    v.isRunoff ? 'Tie last round — vote again between the tied players.' : 'Vote to eliminate one player. Majority is out.'));

  if (iAmAlive) {
    const grid = el('div', { class: 'vote-grid' });
    v.candidates.forEach((id) => {
      if (id === app.me.id) return; // can't vote self
      const p = pub.players.find((x) => x.id === id);
      if (!p) return;
      const selected = priv.myVote === id;
      grid.appendChild(el('button', {
        class: 'btn ' + (selected ? 'btn-primary btn-selected' : 'btn-secondary'),
        onclick: () => intents.vote(id),
      }, p.name));
    });
    wrap.appendChild(grid);
    if (priv.myVote) {
      const votedFor = pub.players.find((x) => x.id === priv.myVote);
      wrap.appendChild(el('p', { class: 'fine', style: 'text-align:center' },
        `You voted for ${votedFor ? votedFor.name : '—'}. Tap another to change.`));
    }
  } else {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'You’re out — watching the vote.')));
  }

  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, `${votedCount} / ${aliveCount} voted`),
    el('div', { class: 'progress-chips' }, ...v.progress.map((x) => {
      const p = pub.players.find((pp) => pp.id === x.id);
      const offline = x.online === false;
      const cls = 'chip' + (offline ? ' offline' : x.voted ? ' done' : '');
      return el('span', { class: cls }, (p ? p.name : '—') + (offline ? ' · offline' : ''));
    }))));

  if (isHost(app) && votedCount < aliveCount) {
    wrap.appendChild(el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.forceResolve() },
      'Force the vote with current tallies'));
  }

  wrap.appendChild(leaveRow(app, intents));
  return wrap;
}

// ---------------------------------------------------------------------------
// ELIMINATION REVEAL
// ---------------------------------------------------------------------------
function eliminationScreen(app, intents) {
  const pub = app.pub;
  const r = pub.reveal || {};
  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, `ROUND ${pub.round} · RESULT`));

  if (r.type === 'none' || !r.eliminated) {
    wrap.appendChild(el('h1', { class: 'hero hero-sm' }, 'No one out'));
    wrap.appendChild(el('p', { class: 'tagline' }, 'The vote was tied — nobody is eliminated this round.'));
  } else {
    const role = describeRole(r.eliminated.role);
    wrap.appendChild(el('h1', { class: 'hero hero-sm' }, r.eliminated.name + ' is out'));
    wrap.appendChild(el('div', { style: 'text-align:center' },
      el('span', { class: 'pill ' + role.color, style: 'font-size:14px;padding:8px 16px' },
        'They were ' + role.name)));
    wrap.appendChild(el('p', { class: 'tagline', style: 'text-align:center' }, role.blurb));
    if (r.random) wrap.appendChild(el('p', { class: 'fine warn', style: 'text-align:center' }, 'Chosen at random (persistent tie).'));
  }

  if (r.tally && r.tally.length) {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Vote tally'),
      ...r.tally.map((t) => el('div', { class: 'tally-row' },
        el('span', { class: 'pname' }, t.name),
        el('span', { class: 'tally-count' }, `${t.votes} vote${t.votes === 1 ? '' : 's'}`)))));
  }

  if (isHost(app)) {
    const nextWhite = r.eliminated && r.eliminated.role === 'mrwhite';
    wrap.appendChild(el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.continueReveal() },
      nextWhite ? 'Mr. White — take your guess →' : 'Continue'));
  } else {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Waiting for the host to continue…')));
  }

  wrap.appendChild(leaveRow(app, intents));
  return wrap;
}

// ---------------------------------------------------------------------------
// MR. WHITE GUESS
// ---------------------------------------------------------------------------
function whiteGuessScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const wg = pub.whiteGuess || {};
  const iGuess = priv && priv.isGuesser;
  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, 'MR. WHITE'));
  wrap.appendChild(el('h1', { class: 'hero hero-sm' }, iGuess ? 'Your last shot' : `${wg.whiteName || 'Mr. White'} is guessing`));

  if (iGuess) {
    wrap.appendChild(el('p', { class: 'tagline' },
      'You were Mr. White. Guess the CIVILIANS’ word exactly and you steal the win.'));
    const input = el('input', {
      class: 'field', type: 'text', maxlength: 30, placeholder: 'the civilians’ word…',
      autocomplete: 'off',
    });
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Your guess'), input,
      el('button', {
        class: 'btn btn-primary btn-block',
        onclick: () => intents.submitGuess(input.value),
      }, 'Lock in my guess')));
  } else {
    wrap.appendChild(el('p', { class: 'tagline' },
      `${wg.whiteName || 'Mr. White'} was voted out and gets one guess at the civilians’ word.`));
    if (isHost(app)) {
      wrap.appendChild(el('button', { class: 'btn btn-secondary btn-block', onclick: () => intents.skipGuess() },
        'Skip guess (Mr. White away)'));
    } else {
      wrap.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-label' }, 'Hold your breath…')));
    }
  }

  wrap.appendChild(leaveRow(app, intents));
  return wrap;
}

// ---------------------------------------------------------------------------
// GAMEOVER
// ---------------------------------------------------------------------------
function gameoverScreen(app, intents) {
  const pub = app.pub;
  const f = pub.final || {};
  const winColor = f.winner === 'civilians' ? 'civ' : f.winner === 'mrwhite' ? 'white' : 'uc';
  const title = f.winner === 'civilians' ? 'Civilians win'
    : f.winner === 'mrwhite' ? 'Mr. White wins'
    : 'Impostors win';

  const wrap = el('div', { class: 'field-group' });
  wrap.appendChild(roomHeader(app, 'GAME OVER'));
  wrap.appendChild(el('h1', { class: 'hero hero-sm ' + winColor, style: `color:var(--${winColor})` }, title));
  wrap.appendChild(el('p', { class: 'tagline' }, f.reason || ''));

  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'The words'),
    el('div', { class: 'words-reveal' },
      el('div', { class: 'word-chip civ' },
        el('div', { class: 'card-label' }, 'Civilians'),
        el('div', { class: 'secret-word civ', style: 'font-size:24px' }, f.words ? f.words.civilianWord : '—')),
      el('div', { class: 'word-chip uc' },
        el('div', { class: 'card-label' }, 'Undercover'),
        el('div', { class: 'secret-word uc', style: 'font-size:24px' }, f.words ? f.words.undercoverWord : '—')))));

  if (f.history && f.history.length) wrap.appendChild(recapCard(f.history));

  const list = el('ul', { class: 'player-list' });
  (f.players || []).forEach((p) => {
    const role = describeRole(p.role);
    list.appendChild(el('li', { class: 'player-row' + (p.alive ? '' : ' eliminated') },
      el('span', { class: 'pname' }, p.name),
      p.word ? el('span', { class: 'fine' }, p.word) : (p.role === 'mrwhite' ? el('span', { class: 'fine' }, 'no word') : null),
      el('span', { class: 'pill ' + role.color }, role.name)));
  });
  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Everyone’s role'), list));

  if (isHost(app)) {
    wrap.appendChild(el('button', { class: 'btn btn-primary btn-block', onclick: () => intents.playAgain() }, 'Play again'));
  } else {
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-label' }, 'Waiting for the host to start a new game…')));
  }
  wrap.appendChild(el('button', { class: 'btn btn-ghost btn-block', onclick: () => intents.leave() }, 'Leave'));
  return wrap;
}

// A round-by-round summary: who was voted out, the tally, and who voted whom.
function recapCard(history) {
  const rounds = history.map((h) => {
    const role = h.eliminated ? describeRole(h.eliminated.role) : null;
    const title = h.eliminated
      ? `${h.eliminated.name} voted out${h.random ? ' (random)' : ''}`
      : 'No one eliminated (tie)';
    const tallyText = (h.tally || []).filter((t) => t.votes > 0)
      .map((t) => `${t.name} ${t.votes}`).join(' · ');
    const votesText = (h.ballots || []).map((b) => `${b.voter} → ${b.target}`).join(', ');

    let whiteLine = null;
    if (h.whiteGuess) {
      const wg = h.whiteGuess;
      whiteLine = el('div', { class: 'fine warn' },
        wg.correct
          ? `Mr. White (${wg.name}) guessed “${wg.guess}” — correct!`
          : (wg.guess
              ? `Mr. White (${wg.name}) guessed “${wg.guess}” — wrong`
              : `Mr. White (${wg.name}) didn’t guess`));
    }

    return el('div', { class: 'recap-round' },
      el('div', { class: 'recap-head' },
        el('span', { class: 'turn-num' }, String(h.round)),
        el('span', { class: 'pname' }, title),
        role ? el('span', { class: 'pill ' + role.color }, role.name) : null),
      tallyText ? el('div', { class: 'fine' }, 'Tally: ' + tallyText) : null,
      votesText ? el('div', { class: 'fine' }, votesText) : null,
      whiteLine);
  });
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, 'Round by round'), ...rounds);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function leaveRow(app, intents) {
  return el('div', { class: 'field-group' },
    el('button', { class: 'link-btn', onclick: () => intents.showRules() }, 'How to play'),
    el('button', { class: 'btn btn-ghost btn-block', onclick: () => intents.leave() }, 'Leave game'));
}

// Sticky "hold to view your word" bar during in-game phases.
function peekOverlay(app) {
  const pub = app.pub;
  const priv = app.priv;
  const inGame = pub && [PHASES.DESCRIBE, PHASES.VOTE, PHASES.REVEAL, PHASES.WHITE_GUESS].includes(pub.phase);
  if (!inGame || !priv || !priv.role) return el('div', { class: 'hidden' });

  const overlay = el('div', { class: 'peek-overlay' }, revealContent(priv),
    el('div', { class: 'peek-hint' }, 'Release to hide'));
  const bar = el('div', { class: 'peek-bar' },
    el('button', {
      class: 'peek-btn',
      'aria-label': 'Hold to view your word — or press Enter to toggle.',
    }, 'Hold to view your word'),
    el('span', { class: 'peek-code' }, 'ROOM ' + app.code));

  const btn = bar.firstChild;
  const show = (e) => { if (e) e.preventDefault(); overlay.classList.add('show'); };
  const hide = () => overlay.classList.remove('show');
  btn.addEventListener('pointerdown', show);
  btn.addEventListener('pointerup', hide);
  btn.addEventListener('pointerleave', hide);
  btn.addEventListener('pointercancel', hide);
  // Same keyboard/switch path as the reveal card: Enter/Space toggles the
  // overlay (a plain hold isn't operable), blur hides it again.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      overlay.classList.toggle('show');
    }
  });
  btn.addEventListener('blur', hide);

  return el('div', {}, overlay, bar);
}

function toastEl(app) {
  const t = el('div', { class: 'toast' + (app.toast ? ' show' : '') }, app.toast || '');
  return t;
}

// ---------------------------------------------------------------------------
// RULES MODAL
// ---------------------------------------------------------------------------
function rulesModal(intents) {
  const body = el('div', { class: 'rules-body' });
  body.innerHTML = `
    <h3>The idea</h3>
    <p>Everyone gets a secret word. <b>Civilians</b> all share the same word.
    <b>Undercover</b> players get a similar — but different — word. <b>Mr. White</b>
    (if enabled) gets no word at all.</p>
    <h3>Each round</h3>
    <ul>
      <li><b>Describe:</b> in turn, say ONE word or short phrase that hints at your
      word — never the word itself. Mr. White has to bluff from what others say.</li>
      <li><b>Vote:</b> everyone votes to eliminate one player. The player who’s out
      reveals their role.</li>
    </ul>
    <h3>Winning</h3>
    <ul>
      <li><b>Civilians</b> win when every undercover and Mr. White is eliminated.</li>
      <li><b>Undercover</b> side wins the moment they equal or outnumber the
      civilians (parity).</li>
      <li><b>Mr. White</b> counts toward that parity — and if voted out, gets one
      guess at the civilians’ word. Guess it exactly and Mr. White steals the win.</li>
    </ul>
    <h3>Vote ties</h3>
    <p>The host chooses how ties are settled: a <b>runoff</b> among the tied players,
    a <b>runoff then random</b> pick, or simply <b>no elimination</b> that round.</p>
    <h3>Privacy</h3>
    <p>Your word only ever shows on your own device — hold the card to peek.</p>
  `;
  const card = el('div', { class: 'modal-card' },
    el('button', { class: 'modal-close', onclick: () => intents.hideRules() }, '×'),
    el('h2', { class: 'modal-title' }, 'How to play'),
    body);
  return el('div', { class: 'modal', onclick: (e) => { if (e.target.classList.contains('modal')) intents.hideRules(); } }, card);
}
