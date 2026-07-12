// ============================================================================
// state.js — host-authoritative Undercover game engine / state machine.
//
// The HOST owns exactly one GameEngine. Every client intent is validated here
// against the rules (rules.js) before any state changes. The engine produces
// two projections:
//   - publicState()        broadcast to everyone; never leaks a living player's
//                          role or either secret word mid-game.
//   - privateStateFor(id)  a single player's secrets (their role + word).
//
// Transport-agnostic: players are identified by an opaque string `id` that the
// controller (main.js) assigns (a P2P connection id, or the host's own id).
// A stable `clientId` lets a dropped player reclaim their seat on reconnect.
// ============================================================================

import {
  ROLES, PHASES, TIE_BREAK, MIN_PLAYERS, MAX_PLAYERS,
  validateRoleConfig, defaultRoleConfig, buildRoleDeck, shuffle,
  pickWordPair, assignWordPair, wordForRole, checkWinner, chooseStarter,
  describeRole, wordsMatch,
} from './rules.js';
import { MIXED } from './words.js';

export { PHASES };

const LOG_CAP = 60;

export class GameEngine {
  constructor(opts = {}) {
    this._rng = opts.rng || Math.random;
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.players = []; // seat order == array order
    this.config = { category: MIXED, undercover: 1, mrwhite: 0, tieBreak: TIE_BREAK.RUNOFF_RANDOM };
    this.words = null; // { civilianWord, undercoverWord } (secret)
    this.round = 0;
    this.speaking = null; // { order:[id], idx }
    this.vote = null;     // { round:'main'|'runoff', candidates:[id], ballots:{voter:target}, runoffCount, tally }
    this.reveal = null;   // { type:'elim'|'none', eliminated:{id,name,role}|null, tally }
    this.whiteGuess = null; // { whiteId, whiteName, wrong }
    this.winner = null;   // 'civilians' | 'undercover' | 'mrwhite'
    this.result = null;   // { winner, reason }
    this.log = [];
  }

  // ---- helpers ------------------------------------------------------------
  getPlayer(id) { return this.players.find((p) => p.id === id) || null; }
  isHost(id) { return id === this.hostId; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  _log(text) { this.log.push({ round: this.round, text }); if (this.log.length > LOG_CAP) this.log.shift(); }

  _reclampConfig() {
    const n = this.players.length;
    if (n < MIN_PLAYERS) return;
    if (!validateRoleConfig(this.config, n).ok) {
      const d = defaultRoleConfig(n);
      this.config.undercover = d.undercover;
      this.config.mrwhite = d.mrwhite;
    }
  }

  // Re-point every id reference from oldId to newId (reconnect adopts new conn).
  _remapId(oldId, newId) {
    if (oldId === newId) return;
    if (this.hostId === oldId) this.hostId = newId;
    const p = this.getPlayer(oldId);
    if (p) p.id = newId;
    if (this.speaking) this.speaking.order = this.speaking.order.map((x) => (x === oldId ? newId : x));
    if (this.vote) {
      this.vote.candidates = this.vote.candidates.map((x) => (x === oldId ? newId : x));
      const b = {};
      for (const [voter, target] of Object.entries(this.vote.ballots)) {
        b[voter === oldId ? newId : voter] = target === oldId ? newId : target;
      }
      this.vote.ballots = b;
    }
    if (this.reveal && this.reveal.eliminated && this.reveal.eliminated.id === oldId) this.reveal.eliminated.id = newId;
    if (this.whiteGuess && this.whiteGuess.whiteId === oldId) this.whiteGuess.whiteId = newId;
  }

  // ---- roster / lobby -----------------------------------------------------
  addPlayer({ id, name, clientId, isHost = false }) {
    const clean = String(name || '').trim().slice(0, 14) || 'Player';

    // Reconnect: same device (clientId) reclaims its seat, even mid-game.
    if (clientId) {
      const seat = this.players.find((p) => p.clientId && p.clientId === clientId);
      if (seat) {
        this._remapId(seat.id, id);
        seat.id = id;
        seat.name = clean;
        seat.online = true;
        return { ok: true, id, reconnected: true };
      }
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'The game has already started.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `Room is full (max ${MAX_PLAYERS}).` };
    }
    if (this.players.some((p) => p.online && p.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, error: 'That name is taken. Pick another.' };
    }

    const player = {
      id, name: clean, clientId: clientId || null, online: true,
      isHost, roleId: null, word: null, alive: true,
      ready: false, hasSpoken: false, guessedWrong: false, eliminatedRound: null,
    };
    this.players.push(player);
    if (isHost) this.hostId = id;
    this._reclampConfig();
    return { ok: true, id, reconnected: false };
  }

  markOffline(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    if (this.phase === PHASES.LOBBY) {
      // In the lobby a dropped player just leaves their seat.
      this.players = this.players.filter((x) => x.id !== id);
      this._reclampConfig();
    } else {
      p.online = false;
    }
  }

  removePlayer(id) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Can only remove players in the lobby.' };
    this.players = this.players.filter((p) => p.id !== id);
    this._reclampConfig();
    return { ok: true };
  }

  setConfig(actorId, partial) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can change settings.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Settings are locked once the game starts.' };
    if (partial.category !== undefined) this.config.category = partial.category;
    if (partial.tieBreak !== undefined && Object.values(TIE_BREAK).includes(partial.tieBreak)) {
      this.config.tieBreak = partial.tieBreak;
    }
    if (partial.undercover !== undefined) this.config.undercover = Math.max(1, Math.floor(partial.undercover));
    if (partial.mrwhite !== undefined) this.config.mrwhite = partial.mrwhite ? 1 : 0;
    return { ok: true };
  }

  // ---- start --------------------------------------------------------------
  startGame(actorId) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can start.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Game already in progress.' };
    const n = this.players.length;
    if (n < MIN_PLAYERS) return { ok: false, error: `Need at least ${MIN_PLAYERS} players.` };
    if (n > MAX_PLAYERS) return { ok: false, error: `Too many players (max ${MAX_PLAYERS}).` };

    if (!validateRoleConfig(this.config, n).ok) {
      const d = defaultRoleConfig(n);
      this.config.undercover = d.undercover;
      this.config.mrwhite = d.mrwhite;
    }

    const deck = shuffle(buildRoleDeck(n, this.config), this._rng);
    const pair = pickWordPair(this.config.category, this._rng);
    this.words = assignWordPair(pair, this._rng);

    this.players.forEach((p, i) => {
      p.roleId = deck[i];
      p.word = wordForRole(deck[i], this.words);
      p.alive = true;
      p.ready = false;
      p.hasSpoken = false;
      p.guessedWrong = false;
      p.eliminatedRound = null;
    });

    this.round = 1;
    this.speaking = null;
    this.vote = null;
    this.reveal = null;
    this.whiteGuess = null;
    this.winner = null;
    this.result = null;
    this.log = [];
    this.phase = PHASES.ROLE_REVEAL;
    this._log('Roles dealt. Everyone, peek at your secret word.');
    return { ok: true };
  }

  // ---- role reveal --------------------------------------------------------
  setReady(actorId) {
    if (this.phase !== PHASES.ROLE_REVEAL) return { ok: false, error: 'Not in the reveal step.' };
    const p = this.getPlayer(actorId);
    if (!p) return { ok: false, error: 'Unknown player.' };
    p.ready = true;
    const onlineUnready = this.players.filter((x) => x.online && !x.ready);
    if (onlineUnready.length === 0) this._startDescribeRound(true);
    return { ok: true };
  }

  beginDescribe(actorId) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can skip ahead.' };
    if (this.phase !== PHASES.ROLE_REVEAL) return { ok: false, error: 'Not in the reveal step.' };
    this._startDescribeRound(true);
    return { ok: true };
  }

  // ---- describe -----------------------------------------------------------
  _startDescribeRound(isFirst) {
    const alive = this.alivePlayers();
    const starterId = chooseStarter(alive.map((p) => ({ id: p.id, role: p.roleId })), this._rng);
    const order = alive.map((p) => p.id);
    const pivot = Math.max(0, order.indexOf(starterId));
    const rotated = order.slice(pivot).concat(order.slice(0, pivot));
    this.speaking = { order: rotated, idx: 0 };
    this.players.forEach((p) => { p.hasSpoken = false; });
    this.reveal = null;
    this.phase = PHASES.DESCRIBE;
    this._log(`Round ${this.round}: describing begins with ${this.getPlayer(starterId)?.name || '—'}.`);
  }

  advanceSpeaker(actorId) {
    if (this.phase !== PHASES.DESCRIBE) return { ok: false, error: 'Not the describing step.' };
    const current = this.speaking.order[this.speaking.idx];
    if (actorId !== current && !this.isHost(actorId)) {
      return { ok: false, error: 'Wait for your turn to describe.' };
    }
    const p = this.getPlayer(current);
    if (p) p.hasSpoken = true;
    this.speaking.idx += 1;
    if (this.speaking.idx >= this.speaking.order.length) this._beginVote();
    return { ok: true };
  }

  // ---- vote ---------------------------------------------------------------
  _beginVote() {
    this.vote = {
      round: 'main',
      candidates: this.alivePlayers().map((p) => p.id),
      ballots: {},
      runoffCount: 0,
      tally: null,
    };
    this.phase = PHASES.VOTE;
    this._log(`Round ${this.round}: vote to eliminate a player.`);
  }

  castVote(voterId, targetId) {
    if (this.phase !== PHASES.VOTE) return { ok: false, error: 'Not the voting step.' };
    const voter = this.getPlayer(voterId);
    if (!voter || !voter.alive) return { ok: false, error: 'Only living players vote.' };
    if (voterId === targetId) return { ok: false, error: 'You cannot vote for yourself.' };
    if (!this.vote.candidates.includes(targetId)) return { ok: false, error: 'Not a valid target.' };
    const target = this.getPlayer(targetId);
    if (!target || !target.alive) return { ok: false, error: 'That player is already out.' };

    this.vote.ballots[voterId] = targetId;

    const aliveVoters = this.alivePlayers();
    const allVoted = aliveVoters.every((p) => this.vote.ballots[p.id]);
    if (allVoted) this._resolveVote();
    return { ok: true };
  }

  forceResolveVote(actorId) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can force the vote.' };
    if (this.phase !== PHASES.VOTE) return { ok: false, error: 'Not the voting step.' };
    this._resolveVote();
    return { ok: true };
  }

  _tally() {
    const counts = {};
    for (const id of this.vote.candidates) counts[id] = 0;
    for (const [, target] of Object.entries(this.vote.ballots)) {
      if (counts[target] !== undefined) counts[target] += 1;
    }
    const list = Object.entries(counts)
      .map(([id, votes]) => ({ id, name: this.getPlayer(id)?.name || '—', votes }))
      .sort((a, b) => b.votes - a.votes);
    const max = list.length ? list[0].votes : 0;
    const winners = list.filter((x) => x.votes === max && max > 0).map((x) => x.id);
    return { list, max, winners };
  }

  _resolveVote() {
    const { list, winners } = this._tally();

    if (winners.length === 1) return this._eliminate(winners[0], list);
    if (winners.length === 0) return this._noElimination(list); // nobody voted

    // Tie between `winners`.
    const mode = this.config.tieBreak;
    if (mode === TIE_BREAK.NONE) return this._noElimination(list);

    if (mode === TIE_BREAK.RUNOFF_RANDOM) {
      if (this.vote.round === 'main') return this._beginRunoff(winners);
      const pick = winners[Math.floor(this._rng() * winners.length)];
      return this._eliminate(pick, list, true);
    }

    // TIE_BREAK.RUNOFF — repeatable, with an anti-stall guard.
    if (this.vote.round === 'runoff'
        && winners.length >= this.vote.candidates.length
        && this.vote.runoffCount >= 2) {
      return this._noElimination(list);
    }
    return this._beginRunoff(winners);
  }

  _beginRunoff(candidateIds) {
    this.vote.round = 'runoff';
    this.vote.candidates = [...candidateIds];
    this.vote.ballots = {};
    this.vote.runoffCount += 1;
    const names = candidateIds.map((id) => this.getPlayer(id)?.name || '—').join(', ');
    this._log(`Tie — runoff between ${names}.`);
  }

  _noElimination(tally) {
    this.reveal = { type: 'none', eliminated: null, tally };
    this.vote = null;
    this.phase = PHASES.REVEAL;
    this._log('The vote was tied — no one is eliminated this round.');
  }

  _eliminate(id, tally, random = false) {
    const p = this.getPlayer(id);
    p.alive = false;
    p.eliminatedRound = this.round;
    this.reveal = {
      type: 'elim',
      eliminated: { id: p.id, name: p.name, role: p.roleId },
      tally,
      random,
    };
    this.vote = null;
    this.phase = PHASES.REVEAL;
    const roleName = describeRole(p.roleId).name;
    this._log(`${p.name} was voted out — they were ${roleName}.${random ? ' (random tiebreak)' : ''}`);
  }

  // ---- reveal continuation -----------------------------------------------
  continueAfterReveal(actorId) {
    if (this.phase !== PHASES.REVEAL) return { ok: false, error: 'Nothing to continue.' };
    if (!this.isHost(actorId)) return { ok: false, error: 'Waiting for the host to continue.' };

    if (!this.reveal || this.reveal.type === 'none') {
      this.round += 1;
      this._startDescribeRound(false);
      return { ok: true };
    }
    if (this.reveal.eliminated.role === ROLES.MRWHITE) {
      const w = this.getPlayer(this.reveal.eliminated.id);
      this.whiteGuess = { whiteId: w.id, whiteName: w.name, wrong: false };
      this.phase = PHASES.WHITE_GUESS;
      this._log(`${w.name} is Mr. White — one guess at the civilians’ word to steal the win.`);
      return { ok: true };
    }
    this._winCheckAndAdvance();
    return { ok: true };
  }

  // ---- Mr. White guess ----------------------------------------------------
  submitWhiteGuess(actorId, guess) {
    if (this.phase !== PHASES.WHITE_GUESS) return { ok: false, error: 'Not the guessing step.' };
    if (!this.whiteGuess || actorId !== this.whiteGuess.whiteId) {
      return { ok: false, error: 'Only Mr. White may guess.' };
    }
    if (wordsMatch(guess, this.words.civilianWord)) {
      this.whiteGuess.guess = String(guess).trim();
      this._endGame('mrwhite', `Mr. White guessed the word — “${this.words.civilianWord}”. Mr. White steals the win!`);
      return { ok: true, correct: true };
    }
    this.whiteGuess.wrong = true;
    this.whiteGuess.guess = String(guess).trim();
    const wp = this.getPlayer(actorId);
    if (wp) wp.guessedWrong = true;
    this._log(`Mr. White guessed “${String(guess).trim()}” — wrong.`);
    this._winCheckAndAdvance();
    return { ok: true, correct: false };
  }

  skipWhiteGuess(actorId) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can skip the guess.' };
    if (this.phase !== PHASES.WHITE_GUESS) return { ok: false, error: 'Not the guessing step.' };
    this.whiteGuess.wrong = true;
    const wp = this.getPlayer(this.whiteGuess.whiteId);
    if (wp) wp.guessedWrong = true;
    this._log('Mr. White did not guess.');
    this._winCheckAndAdvance();
    return { ok: true };
  }

  // ---- win check / advance ------------------------------------------------
  _winCheckAndAdvance() {
    const alive = this.alivePlayers().map((p) => ({ role: p.roleId }));
    const w = checkWinner(alive);
    if (w === 'civilians') {
      this._endGame('civilians', 'All impostors are out — the civilians win!');
    } else if (w === 'undercover') {
      const survivors = this.alivePlayers().filter((p) => p.roleId !== ROLES.CIVILIAN);
      const onlyWhite = survivors.length > 0 && survivors.every((p) => p.roleId === ROLES.MRWHITE);
      this._endGame('undercover',
        onlyWhite
          ? 'Mr. White reached parity — the impostors win!'
          : 'The undercover side reached parity — the impostors win!');
    } else {
      this.round += 1;
      this._startDescribeRound(false);
    }
  }

  _endGame(winner, reason) {
    this.winner = winner;
    this.result = { winner, reason };
    this.whiteGuess = this.whiteGuess || null;
    this.phase = PHASES.GAMEOVER;
    this._log(reason);
  }

  playAgain(actorId) {
    if (!this.isHost(actorId)) return { ok: false, error: 'Only the host can restart.' };
    if (this.phase !== PHASES.GAMEOVER) return { ok: false, error: 'Game is not over.' };
    this.players.forEach((p) => {
      p.roleId = null; p.word = null; p.alive = true;
      p.ready = false; p.hasSpoken = false; p.guessedWrong = false; p.eliminatedRound = null;
    });
    this.words = null;
    this.round = 0;
    this.speaking = null;
    this.vote = null;
    this.reveal = null;
    this.whiteGuess = null;
    this.winner = null;
    this.result = null;
    this.phase = PHASES.LOBBY;
    this._reclampConfig();
    return { ok: true };
  }

  // ---- persistence --------------------------------------------------------
  serialize() {
    return JSON.stringify({
      phase: this.phase, hostId: this.hostId, players: this.players, config: this.config,
      words: this.words, round: this.round, speaking: this.speaking, vote: this.vote,
      reveal: this.reveal, whiteGuess: this.whiteGuess, winner: this.winner, result: this.result,
      log: this.log,
    });
  }

  restore(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    Object.assign(this, s);
    return this;
  }

  // ---- projections --------------------------------------------------------
  publicState() {
    const n = this.players.length;
    const lobby = validateRoleConfig(this.config, n);
    const inGame = this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAMEOVER;

    const players = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      alive: p.alive,
      isHost: p.id === this.hostId,
      hasSpoken: p.hasSpoken,
      eliminatedRound: p.eliminatedRound,
      // Roles are public only for eliminated players, or once the game is over.
      role: (!p.alive || this.phase === PHASES.GAMEOVER) ? p.roleId : null,
    }));

    const pub = {
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      players,
      config: {
        category: this.config.category,
        tieBreak: this.config.tieBreak,
        undercover: this.config.undercover,
        mrwhite: this.config.mrwhite,
      },
      roleCounts: { civilian: lobby.civilian, undercover: lobby.undercover, mrwhite: lobby.mrwhite },
      lobby: { valid: lobby.ok, error: lobby.error, canStart: lobby.ok && n >= MIN_PLAYERS },
      log: this.log.slice(-14),
    };

    if (this.phase === PHASES.DESCRIBE && this.speaking) {
      pub.describe = {
        order: this.speaking.order,
        idx: this.speaking.idx,
        currentSpeakerId: this.speaking.order[this.speaking.idx] || null,
      };
    }

    if (this.phase === PHASES.VOTE && this.vote) {
      pub.vote = {
        round: this.vote.round,
        isRunoff: this.vote.round === 'runoff',
        candidates: this.vote.candidates,
        // Who has voted, never how they voted.
        progress: this.alivePlayers().map((p) => ({ id: p.id, voted: !!this.vote.ballots[p.id] })),
      };
    }

    if (this.phase === PHASES.REVEAL && this.reveal) {
      pub.reveal = {
        type: this.reveal.type,
        eliminated: this.reveal.eliminated, // { id, name, role } or null
        tally: this.reveal.tally,
        random: !!this.reveal.random,
      };
    }

    if (this.phase === PHASES.WHITE_GUESS && this.whiteGuess) {
      pub.whiteGuess = { whiteId: this.whiteGuess.whiteId, whiteName: this.whiteGuess.whiteName };
    }

    if (this.phase === PHASES.GAMEOVER) {
      pub.final = {
        winner: this.winner,
        reason: this.result ? this.result.reason : '',
        words: this.words, // reveal both words at the end
        whiteGuess: this.whiteGuess,
        players: this.players.map((p) => ({
          id: p.id, name: p.name, role: p.roleId, word: p.word,
          alive: p.alive, guessedWrong: p.guessedWrong,
        })),
      };
    }

    return pub;
  }

  privateStateFor(id) {
    const p = this.getPlayer(id);
    if (!p) return null;

    const priv = { id: p.id, name: p.name, alive: p.alive, isHost: p.id === this.hostId };

    if (p.roleId) {
      const d = describeRole(p.roleId);
      priv.role = p.roleId;
      priv.roleName = d.name;
      priv.roleColor = d.color;
      priv.roleBlurb = d.blurb;
      priv.word = p.word; // null for Mr. White
      priv.ready = p.ready;
    }

    if (this.phase === PHASES.DESCRIBE && this.speaking) {
      priv.isMyTurn = this.speaking.order[this.speaking.idx] === id;
    }

    if (this.phase === PHASES.VOTE && this.vote) {
      priv.canVote = p.alive;
      priv.myVote = this.vote.ballots[id] || null;
      priv.hasVoted = !!this.vote.ballots[id];
    }

    if (this.phase === PHASES.WHITE_GUESS && this.whiteGuess) {
      priv.isGuesser = this.whiteGuess.whiteId === id;
    }

    return priv;
  }
}
