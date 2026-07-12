// Correctness harness for the pure rules + host engine. No DOM, no network.
// Run: node scripts/test-engine.mjs
import {
  MIN_PLAYERS, MAX_PLAYERS, ROLES, TIE_BREAK, TIMER,
  defaultRoleConfig, validateRoleConfig, maxUndercover, buildRoleDeck, shuffle,
  assignWordPair, wordForRole, checkWinner, chooseStarter, wordsMatch, clampTimerSeconds,
} from '../js/rules.js';
import { GameEngine, PHASES } from '../js/state.js';
import { MIXED } from '../js/words.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// Deterministic RNG for reproducible shuffles/picks (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// RULES
// ===========================================================================

// Default configs validate + keep civilians a strict majority for every count.
for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
  const cfg = defaultRoleConfig(n);
  const v = validateRoleConfig(cfg, n);
  ok(v.ok, `default config valid for ${n}p: ${v.error}`);
  eq(v.civilian + v.undercover + v.mrwhite, n, `${n}p counts sum to player count`);
  ok(v.civilian > v.undercover + v.mrwhite, `${n}p civilians are a strict majority`);
}

// validateRoleConfig rejects bad combos.
ok(!validateRoleConfig({ undercover: 0, mrwhite: 0 }, 6).ok, 'zero undercover rejected');
ok(!validateRoleConfig({ undercover: 1, mrwhite: 2 }, 8).ok, 'two Mr. White rejected');
ok(!validateRoleConfig({ undercover: 2, mrwhite: 0 }, 4).ok, '4p with 2 undercover (no majority) rejected');
ok(!validateRoleConfig({ undercover: 1, mrwhite: 1 }, 4).ok, '4p with 1uc+1white (parity start) rejected');
ok(validateRoleConfig({ undercover: 1, mrwhite: 0 }, 4).ok, '4p 1uc/0white accepted');
ok(!validateRoleConfig({ undercover: 1, mrwhite: 0 }, 3).ok, '3 players rejected (below min)');

// maxUndercover is the largest that still validates.
{
  const m = maxUndercover(8, 1); // 8p, with Mr. White: civ must be > uc+1
  ok(validateRoleConfig({ undercover: m, mrwhite: 1 }, 8).ok, `8p maxUndercover ${m} valid`);
  ok(!validateRoleConfig({ undercover: m + 1, mrwhite: 1 }, 8).ok, `8p maxUndercover ${m} is the ceiling`);
}

// buildRoleDeck composition.
{
  const deck = buildRoleDeck(8, { undercover: 2, mrwhite: 1 });
  eq(deck.length, 8, 'deck length = player count');
  eq(deck.filter((r) => r === ROLES.UNDERCOVER).length, 2, 'deck has 2 undercover');
  eq(deck.filter((r) => r === ROLES.MRWHITE).length, 1, 'deck has 1 Mr. White');
  eq(deck.filter((r) => r === ROLES.CIVILIAN).length, 5, 'deck has 5 civilians');
}

// shuffle preserves the multiset.
{
  const src = buildRoleDeck(10, { undercover: 3, mrwhite: 1 });
  const before = [...src].sort();
  const after = [...shuffle([...src], rng(42))].sort();
  eq(after, before, 'shuffle preserves the multiset');
}

// assignWordPair returns both words of the pair, one per side.
{
  const w = assignWordPair(['Coffee', 'Tea'], rng(1));
  ok([w.civilianWord, w.undercoverWord].sort().join('|') === 'Coffee|Tea', 'both words assigned');
  ok(w.civilianWord !== w.undercoverWord, 'sides get different words');
}

// wordForRole mapping (Mr. White gets nothing).
{
  const words = { civilianWord: 'Coffee', undercoverWord: 'Tea' };
  eq(wordForRole(ROLES.CIVILIAN, words), 'Coffee', 'civilian word');
  eq(wordForRole(ROLES.UNDERCOVER, words), 'Tea', 'undercover word');
  eq(wordForRole(ROLES.MRWHITE, words), null, 'Mr. White has no word');
}

// checkWinner: civilians / undercover-parity / continue.
{
  const civ = (n) => Array.from({ length: n }, () => ({ role: ROLES.CIVILIAN }));
  eq(checkWinner([...civ(3)]), 'civilians', 'all non-civ gone => civilians win');
  eq(checkWinner([...civ(2), { role: ROLES.UNDERCOVER }]), null, '2 civ vs 1 uc continues');
  eq(checkWinner([...civ(1), { role: ROLES.UNDERCOVER }]), 'undercover', '1 civ vs 1 uc => parity, undercover win');
  eq(checkWinner([...civ(2), { role: ROLES.UNDERCOVER }, { role: ROLES.MRWHITE }]), 'undercover', 'Mr. White counts toward parity');
  eq(checkWinner([...civ(3), { role: ROLES.UNDERCOVER }, { role: ROLES.MRWHITE }]), null, '3 civ vs 2 non-civ continues');
}

// chooseStarter never opens with Mr. White when a non-white is alive.
{
  const alive = [
    { id: 'a', role: ROLES.CIVILIAN },
    { id: 'b', role: ROLES.MRWHITE },
    { id: 'c', role: ROLES.UNDERCOVER },
  ];
  let sawWhite = false;
  for (let s = 0; s < 200; s++) {
    const starter = chooseStarter(alive, rng(s));
    if (starter === 'b') sawWhite = true;
  }
  ok(!sawWhite, 'Mr. White is never chosen to speak first');
}

// wordsMatch: forgiving comparison.
ok(wordsMatch('Coffee', 'coffee'), 'case-insensitive match');
ok(wordsMatch('  ICE cream ', 'Ice Cream'), 'trims + collapses spaces + punctuation');
ok(!wordsMatch('Tea', 'Coffee'), 'different words do not match');
ok(!wordsMatch('', 'Coffee'), 'empty guess never matches');

// clampTimerSeconds: snaps to STEP and stays within [MIN, MAX].
eq(clampTimerSeconds(30), 30, 'timer 30 stays 30');
eq(clampTimerSeconds(5), TIMER.MIN, 'timer below min clamps up');
eq(clampTimerSeconds(999), TIMER.MAX, 'timer above max clamps down');
eq(clampTimerSeconds(32), 30, 'timer snaps to nearest step');
eq(clampTimerSeconds('abc'), TIMER.DEFAULT, 'non-numeric timer -> default');

// ===========================================================================
// ENGINE
// ===========================================================================

function setup(nPlayers, cfg, seed) {
  const g = new GameEngine({ rng: rng(seed) });
  for (let i = 0; i < nPlayers; i++) {
    g.addPlayer({ id: 'p' + i, name: 'P' + i, clientId: 'c' + i, isHost: i === 0 });
  }
  g.setConfig(g.hostId, {
    category: MIXED,
    tieBreak: cfg.tieBreak || TIE_BREAK.RUNOFF_RANDOM,
    undercover: cfg.undercover,
    mrwhite: cfg.mrwhite,
  });
  g.startGame(g.hostId);
  return g;
}
function readyAll(g) { for (const p of g.players) g.setReady(p.id); }
function describeAll(g) {
  let guard = 0;
  while (g.phase === PHASES.DESCRIBE && guard++ < 60) {
    g.advanceSpeaker(g.speaking.order[g.speaking.idx]);
  }
}
// Everyone piles votes onto `targetId` (the target casts a throwaway vote so it
// isn't a self-vote). Produces a clean majority when 3+ players are alive.
function voteOut(g, targetId) {
  const alive = g.alivePlayers().map((p) => p.id);
  const other = alive.find((id) => id !== targetId);
  for (const v of alive) g.castVote(v, v === targetId ? other : targetId);
}
function roleId(g, role) { return g.players.find((p) => p.roleId === role).id; }
function firstCivAlive(g) { return g.alivePlayers().find((p) => p.roleId === ROLES.CIVILIAN).id; }

// --- Setup basics ----------------------------------------------------------
{
  const g = setup(6, { undercover: 1, mrwhite: 1 }, 7);
  eq(g.phase, PHASES.ROLE_REVEAL, 'startGame -> roleReveal');
  eq(g.players.filter((p) => p.roleId === ROLES.UNDERCOVER).length, 1, 'dealt 1 undercover');
  eq(g.players.filter((p) => p.roleId === ROLES.MRWHITE).length, 1, 'dealt 1 Mr. White');
  eq(g.players.filter((p) => p.roleId === ROLES.CIVILIAN).length, 4, 'dealt 4 civilians');
  const civWord = g.words.civilianWord, ucWord = g.words.undercoverWord;
  ok(civWord && ucWord && civWord !== ucWord, 'two distinct secret words assigned');
  const civ = g.players.find((p) => p.roleId === ROLES.CIVILIAN);
  const uc = g.players.find((p) => p.roleId === ROLES.UNDERCOVER);
  const wh = g.players.find((p) => p.roleId === ROLES.MRWHITE);
  eq(civ.word, civWord, 'civilian holds civilian word');
  eq(uc.word, ucWord, 'undercover holds undercover word');
  eq(wh.word, null, 'Mr. White holds no word');
}

// --- publicState hides secrets, privateState reveals only your own ----------
{
  const g = setup(5, { undercover: 1, mrwhite: 1 }, 11);
  const pub = g.publicState();
  ok(pub.players.every((p) => p.role === null), 'public: no living roles leaked in reveal phase');
  ok(pub.final === undefined && pub.words === undefined, 'public: no words leaked mid-game');
  const uc = roleId(g, ROLES.UNDERCOVER);
  const priv = g.privateStateFor(uc);
  eq(priv.role, ROLES.UNDERCOVER, 'private: you see your own role');
  eq(priv.word, g.words.undercoverWord, 'private: you see your own word');
  const whPriv = g.privateStateFor(roleId(g, ROLES.MRWHITE));
  eq(whPriv.word, null, 'private: Mr. White sees no word');
}

// --- Scenario A: civilians win (vote out the only undercover) ---------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 3);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'all ready -> describe');
  const uc = roleId(g, ROLES.UNDERCOVER);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'describing done -> vote');
  voteOut(g, uc);
  eq(g.phase, PHASES.REVEAL, 'majority -> reveal');
  eq(g.reveal.eliminated.role, ROLES.UNDERCOVER, 'reveal shows undercover out');
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'all impostors out -> gameover');
  eq(g.winner, 'civilians', 'civilians win');
  ok(g.publicState().final.words.civilianWord, 'gameover reveals words');
}

// --- Scenario B: undercover wins on parity ---------------------------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 5);
  readyAll(g);
  // Round 1: vote out a civilian (4 -> 3 alive, no winner yet).
  describeAll(g);
  voteOut(g, firstCivAlive(g));
  eq(g.reveal.eliminated.role, ROLES.CIVILIAN, 'round1 civilian out');
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.DESCRIBE, '3 alive (2civ,1uc) -> next round');
  eq(g.winner, null, 'no winner yet');
  // Round 2: vote out another civilian (3 -> 2 alive => parity).
  describeAll(g);
  voteOut(g, firstCivAlive(g));
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'parity -> gameover');
  eq(g.winner, 'undercover', 'undercover wins on parity');
}

// --- Scenario C: Mr. White steals the win by guessing ----------------------
{
  const g = setup(5, { undercover: 1, mrwhite: 1 }, 9);
  readyAll(g);
  const wh = roleId(g, ROLES.MRWHITE);
  describeAll(g);
  voteOut(g, wh);
  eq(g.reveal.eliminated.role, ROLES.MRWHITE, 'Mr. White voted out');
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.WHITE_GUESS, 'reveal -> white guess');
  const r = g.submitWhiteGuess(wh, g.words.civilianWord);
  ok(r.correct, 'correct guess reported');
  eq(g.phase, PHASES.GAMEOVER, 'correct guess -> gameover');
  eq(g.winner, 'mrwhite', 'Mr. White wins');
}

// --- Scenario D: Mr. White guesses wrong, game continues -------------------
{
  const g = setup(6, { undercover: 1, mrwhite: 1 }, 13);
  readyAll(g);
  const wh = roleId(g, ROLES.MRWHITE);
  describeAll(g);
  voteOut(g, wh);
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.WHITE_GUESS, 'reveal -> white guess');
  const r = g.submitWhiteGuess(wh, 'definitely-not-the-word');
  ok(!r.correct, 'wrong guess reported');
  // 5 alive (4 civ, 1 uc) -> game continues.
  eq(g.phase, PHASES.DESCRIBE, 'wrong guess -> next describe round');
  eq(g.winner, null, 'no winner after wrong guess');
  ok(g.players.find((p) => p.id === wh).guessedWrong, 'white marked as guessed wrong');
}

// --- Vote can't target yourself / non-candidates ---------------------------
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 21);
  readyAll(g);
  describeAll(g);
  const a = g.alivePlayers()[0].id;
  ok(!g.castVote(a, a).ok, 'self-vote rejected');
  ok(!g.castVote(a, 'nobody').ok, 'vote for non-candidate rejected');
  ok(g.castVote(a, g.alivePlayers()[1].id).ok, 'valid vote accepted');
}

// --- Tie-break: NONE -> no elimination -------------------------------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0, tieBreak: TIE_BREAK.NONE }, 4);
  readyAll(g);
  describeAll(g);
  const [A, B, C, D] = g.alivePlayers().map((p) => p.id);
  g.castVote(A, C); g.castVote(B, D); g.castVote(C, D); g.castVote(D, C); // 2-2 tie C/D
  eq(g.phase, PHASES.REVEAL, 'tie -> reveal');
  eq(g.reveal.type, 'none', 'NONE tiebreak -> nobody eliminated');
  eq(g.alivePlayers().length, 4, 'still 4 alive after tie');
}

// --- Tie-break: RUNOFF_RANDOM -> runoff, then random -----------------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0, tieBreak: TIE_BREAK.RUNOFF_RANDOM }, 8);
  readyAll(g);
  describeAll(g);
  const [A, B, C, D] = g.alivePlayers().map((p) => p.id);
  g.castVote(A, C); g.castVote(B, D); g.castVote(C, D); g.castVote(D, C); // tie C/D
  eq(g.phase, PHASES.VOTE, 'main tie -> stay in vote for runoff');
  ok(g.vote.round === 'runoff', 'runoff started');
  eq(JSON.stringify([...g.vote.candidates].sort()), JSON.stringify([C, D].sort()), 'runoff between tied players');
  // Runoff ties again -> random elimination among tied.
  g.castVote(A, C); g.castVote(B, D); g.castVote(C, D); g.castVote(D, C);
  eq(g.phase, PHASES.REVEAL, 'runoff tie -> random elimination');
  ok([C, D].includes(g.reveal.eliminated.id), 'random pick is one of the tied');
  ok(g.reveal.random, 'flagged as random tiebreak');
}

// --- Tie-break: RUNOFF creates a runoff ------------------------------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0, tieBreak: TIE_BREAK.RUNOFF }, 6);
  readyAll(g);
  describeAll(g);
  const [A, B, C, D] = g.alivePlayers().map((p) => p.id);
  g.castVote(A, C); g.castVote(B, D); g.castVote(C, D); g.castVote(D, C);
  eq(g.phase, PHASES.VOTE, 'RUNOFF: main tie stays in vote');
  ok(g.vote.round === 'runoff' && g.vote.runoffCount === 1, 'first runoff opened');
}

// --- Reconnect: same clientId reclaims seat and remaps id -------------------
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 2);
  readyAll(g);
  describeAll(g); // now in VOTE
  const voter = g.alivePlayers()[0];
  const target = g.alivePlayers()[1].id;
  g.castVote(voter.id, target);
  const oldId = voter.id, cid = voter.clientId;
  g.addPlayer({ id: 'reconn-1', name: voter.name, clientId: cid });
  ok(!g.getPlayer(oldId), 'old id no longer present');
  ok(g.getPlayer('reconn-1'), 'seat reclaimed under new id');
  eq(g.getPlayer('reconn-1').clientId, cid, 'clientId preserved');
  eq(g.vote.ballots['reconn-1'], target, 'ballot remapped to new id');
  ok(g.vote.candidates.includes('reconn-1'), 'candidate list remapped');
}

// --- playAgain resets to lobby, keeps players ------------------------------
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 3);
  readyAll(g);
  describeAll(g);
  voteOut(g, roleId(g, ROLES.UNDERCOVER));
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'reached gameover');
  g.playAgain(g.hostId);
  eq(g.phase, PHASES.LOBBY, 'playAgain -> lobby');
  eq(g.players.length, 4, 'players kept');
  ok(g.players.every((p) => p.roleId === null && p.alive), 'roles cleared, all alive again');
}

// --- serialize / restore round-trips ---------------------------------------
{
  const g = setup(5, { undercover: 1, mrwhite: 1 }, 15);
  readyAll(g);
  describeAll(g);
  const snap = g.serialize();
  const g2 = new GameEngine().restore(snap);
  eq(g2.phase, g.phase, 'restore keeps phase');
  eq(JSON.stringify(g2.publicState()), JSON.stringify(g.publicState()), 'restore reproduces public state');
}

// ===========================================================================
// RECAP HISTORY
// ===========================================================================

// Each vote round is recorded with its outcome, tally, and ballots.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 3);
  readyAll(g);
  describeAll(g);
  const uc = roleId(g, ROLES.UNDERCOVER);
  voteOut(g, uc);
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'recap: reached gameover');
  eq(g.history.length, 1, 'recap: one round recorded');
  const h0 = g.history[0];
  eq(h0.round, 1, 'recap: round number captured');
  eq(h0.eliminated.role, ROLES.UNDERCOVER, 'recap: undercover recorded as eliminated');
  ok(h0.tally.length > 0, 'recap: tally captured');
  eq(h0.ballots.length, g.players.length, 'recap: a ballot per voter');
  ok(h0.ballots.every((b) => b.voter && b.target), 'recap: ballots name voter + target');
  eq(g.publicState().final.history.length, 1, 'recap: exposed via public final state');
}

// A multi-round game records one entry per vote round, in order.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 5);
  readyAll(g);
  describeAll(g);
  voteOut(g, firstCivAlive(g));
  g.continueAfterReveal(g.hostId);
  describeAll(g);
  voteOut(g, firstCivAlive(g));
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'recap multi: gameover on parity');
  eq(g.history.length, 2, 'recap multi: two rounds recorded');
  eq(g.history[0].eliminated.role, ROLES.CIVILIAN, 'recap multi: round 1 civilian out');
  eq(g.history[1].eliminated.role, ROLES.CIVILIAN, 'recap multi: round 2 civilian out');
  eq(g.history[1].round, 2, 'recap multi: second entry is round 2');
}

// Mr. White's correct guess is folded into the round they were voted out.
{
  const g = setup(5, { undercover: 1, mrwhite: 1 }, 9);
  readyAll(g);
  const wh = roleId(g, ROLES.MRWHITE);
  describeAll(g);
  voteOut(g, wh);
  g.continueAfterReveal(g.hostId);
  g.submitWhiteGuess(wh, g.words.civilianWord);
  const last = g.history[g.history.length - 1];
  eq(last.eliminated.role, ROLES.MRWHITE, 'recap: that round eliminated Mr. White');
  ok(last.whiteGuess && last.whiteGuess.correct, 'recap: correct white guess folded in');
  eq(last.whiteGuess.guess, g.words.civilianWord, 'recap: white guess text captured');
}

// A wrong Mr. White guess is recorded as incorrect.
{
  const g = setup(6, { undercover: 1, mrwhite: 1 }, 13);
  readyAll(g);
  const wh = roleId(g, ROLES.MRWHITE);
  describeAll(g);
  voteOut(g, wh);
  g.continueAfterReveal(g.hostId);
  g.submitWhiteGuess(wh, 'definitely-not-the-word');
  const wgRound = g.history.find((h) => h.eliminated && h.eliminated.role === ROLES.MRWHITE);
  ok(wgRound.whiteGuess && !wgRound.whiteGuess.correct, 'recap: wrong white guess recorded');
}

// A tied round with NONE tiebreak records a no-elimination entry.
{
  const g = setup(4, { undercover: 1, mrwhite: 0, tieBreak: TIE_BREAK.NONE }, 4);
  readyAll(g);
  describeAll(g);
  const [A, B, C, D] = g.alivePlayers().map((p) => p.id);
  g.castVote(A, C); g.castVote(B, D); g.castVote(C, D); g.castVote(D, C); // 2-2 tie
  eq(g.history.length, 1, 'recap: tie round recorded');
  eq(g.history[0].eliminated, null, 'recap: no elimination stored as null');
  eq(g.history[0].ballots.length, 4, 'recap: tie ballots captured');
}

// History survives serialize/restore and is cleared by playAgain.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 3);
  readyAll(g);
  describeAll(g);
  voteOut(g, roleId(g, ROLES.UNDERCOVER));
  g.continueAfterReveal(g.hostId);
  const g2 = new GameEngine().restore(g.serialize());
  eq(JSON.stringify(g2.history), JSON.stringify(g.history), 'recap: history round-trips through serialize');
  g.playAgain(g.hostId);
  eq(g.history.length, 0, 'recap: playAgain clears history');
}

// ===========================================================================
// TURN TIMER
// ===========================================================================

// Off by default: describe turns carry no deadline.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 3);
  eq(g.config.timer, false, 'timer off by default');
  readyAll(g);
  const d = g.publicState().describe;
  eq(d.endsAt, null, 'timer off: no deadline on the turn');
  eq(d.seconds, null, 'timer off: no seconds on the turn');
}

// setConfig toggles the timer and clamps the duration (lobby only).
{
  const g = new GameEngine({ rng: rng(9) });
  for (let i = 0; i < 4; i++) g.addPlayer({ id: 'p'+i, name: 'P'+i, clientId: 'c'+i, isHost: i === 0 });
  g.setConfig(g.hostId, { timer: true, timerSeconds: 999 });
  eq(g.config.timer, true, 'timer enabled via setConfig');
  eq(g.config.timerSeconds, TIMER.MAX, 'setConfig clamps duration to max');
  g.setConfig(g.hostId, { timerSeconds: 3 });
  eq(g.config.timerSeconds, TIMER.MIN, 'setConfig clamps duration to min');
  g.setConfig(g.hostId, { timer: false });
  eq(g.config.timer, false, 'timer can be turned back off');
}

// When enabled, each turn gets an absolute deadline that re-arms on advance.
{
  let clock = 1_000_000;
  const g = new GameEngine({ rng: rng(3), now: () => clock });
  for (let i = 0; i < 4; i++) g.addPlayer({ id: 'p'+i, name: 'P'+i, clientId: 'c'+i, isHost: i === 0 });
  g.setConfig(g.hostId, { category: MIXED, undercover: 1, mrwhite: 0, timer: true, timerSeconds: 45 });
  g.startGame(g.hostId);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'timer: reached describe');
  const d1 = g.publicState().describe;
  eq(d1.seconds, 45, 'timer: turn length exposed');
  eq(d1.endsAt, clock + 45 * 1000, 'timer: deadline = now + duration');
  clock += 10_000; // time passes before the speaker advances
  g.advanceSpeaker(d1.currentSpeakerId);
  const d2 = g.publicState().describe;
  eq(d2.idx, 1, 'timer: advanced to the next speaker');
  eq(d2.endsAt, clock + 45 * 1000, 'timer: deadline re-armed for the new turn');
}

// The timer config + live deadline survive serialize/restore.
{
  let clock = 500_000;
  const g = new GameEngine({ rng: rng(7), now: () => clock });
  for (let i = 0; i < 4; i++) g.addPlayer({ id: 'p'+i, name: 'P'+i, clientId: 'c'+i, isHost: i === 0 });
  g.setConfig(g.hostId, { category: MIXED, undercover: 1, mrwhite: 0, timer: true, timerSeconds: 20 });
  g.startGame(g.hostId);
  readyAll(g);
  const g2 = new GameEngine().restore(g.serialize());
  eq(g2.config.timer, true, 'restore keeps timer flag');
  eq(g2.config.timerSeconds, 20, 'restore keeps timer duration');
  eq(g2.publicState().describe.endsAt, g.publicState().describe.endsAt, 'restore keeps the turn deadline');
}

// ===========================================================================
// OFFLINE PLAYERS (a drop must never freeze the round)
// ===========================================================================

// A vote resolves without ever waiting on an offline living player.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 21);
  readyAll(g);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'offline vote: reached vote');
  const alive = g.alivePlayers().map((p) => p.id);
  const offlineId = alive[0];
  g.markOffline(offlineId);
  eq(g.phase, PHASES.VOTE, 'offline vote: still open right after a player drops');
  const connected = alive.filter((id) => id !== offlineId);
  const target = connected[0];
  for (const id of connected) g.castVote(id, id === target ? connected[1] : target);
  eq(g.phase, PHASES.REVEAL, 'offline vote: resolves once every connected player has voted');
}

// Dropping the last un-voted player mid-vote triggers immediate resolution.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 33);
  readyAll(g);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'offline midvote: reached vote');
  const alive = g.alivePlayers().map((p) => p.id);
  const holdout = alive[4];
  const target = alive[0];
  for (const id of alive) {
    if (id === holdout) continue;
    g.castVote(id, id === target ? alive[1] : target);
  }
  eq(g.phase, PHASES.VOTE, 'offline midvote: open while a connected player has not voted');
  g.markOffline(holdout);
  eq(g.phase, PHASES.REVEAL, 'offline midvote: dropping the holdout resolves the tally');
}

// Describing auto-skips a speaker who drops on their turn.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 55);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'offline describe: reached describe');
  const first = g.publicState().describe.currentSpeakerId;
  g.markOffline(first);
  const d2 = g.publicState().describe;
  ok(d2.currentSpeakerId !== first, 'offline describe: cursor advances past the dropped speaker');
  ok(g.getPlayer(d2.currentSpeakerId).online, 'offline describe: the new current speaker is online');
}

// Describing jumps straight to the vote when every remaining speaker is gone.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 77);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'offline all-drop: reached describe');
  for (const id of [...g.speaking.order]) g.markOffline(id);
  eq(g.phase, PHASES.VOTE, 'offline all-drop: an exhausted speaking order moves to the vote');
}

// An offline player never blocks the ready->describe gate, and the round opens
// on someone who is actually connected.
{
  const g = setup(6, { undercover: 1, mrwhite: 0 }, 88);
  eq(g.phase, PHASES.ROLE_REVEAL, 'offline start: in role reveal');
  g.markOffline('p3'); // drops during reveal — the seat is kept, unlike the lobby
  for (const p of g.players) if (p.online) g.setReady(p.id);
  eq(g.phase, PHASES.DESCRIBE, 'offline start: offline player never readies, round still begins');
  const cur = g.getPlayer(g.publicState().describe.currentSpeakerId);
  ok(cur && cur.online, 'offline start: describing begins with an online player');
}

// vote.progress carries an `online` flag so the UI can stop waiting on drops.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 99);
  readyAll(g);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'offline progress: reached vote');
  const alive = g.alivePlayers().map((p) => p.id);
  g.markOffline(alive[0]);
  const prog = g.publicState().vote.progress;
  eq(prog.find((x) => x.id === alive[0]).online, false, 'offline progress: dropped player flagged online:false');
  ok(prog.filter((x) => x.id !== alive[0]).every((x) => x.online === true), 'offline progress: connected players stay online:true');
}

// A drop in the lobby simply frees the seat (no phase machinery to unstick).
{
  const g = new GameEngine({ rng: rng(4) });
  for (let i = 0; i < 5; i++) g.addPlayer({ id: 'p'+i, name: 'P'+i, clientId: 'c'+i, isHost: i === 0 });
  eq(g.phase, PHASES.LOBBY, 'offline lobby: still in lobby');
  g.markOffline('p3');
  eq(g.players.length, 4, 'offline lobby: a dropped player leaves their seat');
  ok(!g.getPlayer('p3'), 'offline lobby: the seat is gone, not just flagged');
}

// ===========================================================================
// KICK / REMOVE PLAYER (host moderation, lobby + mid-game)
// ===========================================================================

// Guards: only the host kicks, never the host, never a stranger.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 201);
  ok(!g.kickPlayer('p1', 'p2').ok, 'kick: a non-host is refused');
  ok(g.getPlayer('p2'), 'kick: target survives a refused kick');
  ok(!g.kickPlayer(g.hostId, g.hostId).ok, 'kick: the host cannot be removed');
  ok(!g.kickPlayer(g.hostId, 'nobody').ok, 'kick: an unknown target is refused');
}

// Lobby kick just frees the seat (delegates to removePlayer + reclamp).
{
  const g = new GameEngine({ rng: rng(204) });
  for (let i = 0; i < 5; i++) g.addPlayer({ id: 'p'+i, name: 'P'+i, clientId: 'c'+i, isHost: i === 0 });
  ok(g.kickPlayer('p0', 'p3').ok, 'kick lobby: removal ok');
  eq(g.players.length, 4, 'kick lobby: seat freed');
  ok(!g.getPlayer('p3'), 'kick lobby: player gone');
}

// During role reveal, removing the last unready player starts the round.
{
  const g = setup(6, { undercover: 1, mrwhite: 0 }, 205);
  eq(g.phase, PHASES.ROLE_REVEAL, 'kick reveal: in role reveal');
  const civ = g.players.find((p) => p.roleId === ROLES.CIVILIAN && p.id !== g.hostId).id;
  for (const p of g.players) if (p.id !== civ) g.setReady(p.id);
  eq(g.phase, PHASES.ROLE_REVEAL, 'kick reveal: still waiting on the unready civilian');
  ok(g.kickPlayer(g.hostId, civ).ok, 'kick reveal: removal ok');
  eq(g.phase, PHASES.DESCRIBE, 'kick reveal: removing the last holdout begins describing');
  ok(!g.getPlayer(civ), 'kick reveal: player gone');
}

// Removing an upcoming speaker shrinks the order but keeps the current speaker.
{
  const g = setup(6, { undercover: 1, mrwhite: 0 }, 206);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'kick describe: describing');
  const d = g.publicState().describe;
  const curId = d.currentSpeakerId;
  const lenBefore = d.order.length;
  const victim = d.order.slice(d.idx + 1)
    .find((id) => id !== g.hostId && g.getPlayer(id).roleId === ROLES.CIVILIAN);
  ok(g.kickPlayer(g.hostId, victim).ok, 'kick describe: upcoming speaker removed');
  const d2 = g.publicState().describe;
  eq(d2.order.length, lenBefore - 1, 'kick describe: speaking order shrank by one');
  eq(d2.currentSpeakerId, curId, 'kick describe: current speaker preserved');
  ok(!d2.order.includes(victim), 'kick describe: victim gone from the order');
  eq(g.phase, PHASES.DESCRIBE, 'kick describe: the round keeps going');
}

// Removing the current speaker steps the next player up (or moves to the vote).
{
  const g = setup(6, { undercover: 1, mrwhite: 0 }, 207);
  readyAll(g);
  let cur = g.getPlayer(g.speaking.order[g.speaking.idx]);
  while (g.phase === PHASES.DESCRIBE && cur && (cur.id === g.hostId || cur.roleId !== ROLES.CIVILIAN)) {
    g.advanceSpeaker(g.speaking.order[g.speaking.idx]);
    cur = g.speaking ? g.getPlayer(g.speaking.order[g.speaking.idx]) : null;
  }
  ok(g.phase === PHASES.DESCRIBE && cur, 'kick current: parked on a removable current speaker');
  const victimId = cur.id;
  const nextId = g.speaking.order[g.speaking.idx + 1] || null;
  ok(g.kickPlayer(g.hostId, victimId).ok, 'kick current: current speaker removed');
  ok(!g.getPlayer(victimId), 'kick current: player gone');
  if (g.phase === PHASES.DESCRIBE) {
    eq(g.speaking.order[g.speaking.idx], nextId, 'kick current: the next speaker steps up');
  } else {
    eq(g.phase, PHASES.VOTE, 'kick current: removing the final speaker moves to the vote');
  }
}

// Removing the last impostor mid-describe ends the game for the civilians.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 300);
  readyAll(g);
  eq(g.phase, PHASES.DESCRIBE, 'kick win: describing');
  const uc = roleId(g, ROLES.UNDERCOVER);
  ok(uc !== g.hostId, 'kick win: undercover is a guest for this seed');
  ok(g.kickPlayer(g.hostId, uc).ok, 'kick win: undercover removed');
  eq(g.phase, PHASES.GAMEOVER, 'kick win: no impostor left -> game over');
  eq(g.winner, 'civilians', 'kick win: civilians win');
}

// Mid-vote: the departed player's ballot + candidacy are scrubbed, and losing
// the last non-voter resolves the tally.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 209);
  readyAll(g);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'kick vote: voting');
  const alive = g.alivePlayers().map((p) => p.id);
  const victim = alive.find((id) => id !== g.hostId && g.getPlayer(id).roleId === ROLES.CIVILIAN);
  const others = alive.filter((id) => id !== victim);
  const target = others[0];
  for (const id of others) g.castVote(id, id === target ? others[1] : target);
  ok(g.vote.candidates.includes(victim), 'kick vote: victim is a candidate before removal');
  eq(g.phase, PHASES.VOTE, 'kick vote: open while the victim has not voted');
  ok(g.kickPlayer(g.hostId, victim).ok, 'kick vote: victim removed mid-vote');
  eq(g.phase, PHASES.REVEAL, 'kick vote: dropping the last non-voter resolves the vote');
}

// Mid-vote removal can also settle the game outright.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 210);
  readyAll(g);
  describeAll(g);
  eq(g.phase, PHASES.VOTE, 'kick vote-win: voting');
  const uc = roleId(g, ROLES.UNDERCOVER);
  ok(uc !== g.hostId, 'kick vote-win: undercover is a guest for this seed');
  ok(g.kickPlayer(g.hostId, uc).ok, 'kick vote-win: undercover removed');
  eq(g.phase, PHASES.GAMEOVER, 'kick vote-win: last impostor gone -> game over');
  eq(g.winner, 'civilians', 'kick vote-win: civilians win');
}

// Kicking is deferred during the transient reveal / guess steps.
{
  const g = setup(5, { undercover: 1, mrwhite: 0 }, 211);
  readyAll(g);
  describeAll(g);
  voteOut(g, firstCivAlive(g));
  eq(g.phase, PHASES.REVEAL, 'kick reveal-phase: at the reveal');
  const someone = g.alivePlayers().find((p) => p.id !== g.hostId).id;
  ok(!g.kickPlayer(g.hostId, someone).ok, 'kick reveal-phase: refused during the reveal');
  ok(g.getPlayer(someone), 'kick reveal-phase: target retained');
}
{
  const g = setup(5, { undercover: 1, mrwhite: 1 }, 212);
  readyAll(g);
  const wh = roleId(g, ROLES.MRWHITE);
  describeAll(g);
  voteOut(g, wh);
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.WHITE_GUESS, 'kick guess-phase: at the white guess');
  const someone = g.alivePlayers().find((p) => p.id !== g.hostId).id;
  ok(!g.kickPlayer(g.hostId, someone).ok, 'kick guess-phase: refused during the white guess');
}

// After the game, a kick simply frees the seat without disturbing the result.
{
  const g = setup(4, { undercover: 1, mrwhite: 0 }, 213);
  readyAll(g);
  const uc = roleId(g, ROLES.UNDERCOVER);
  describeAll(g);
  voteOut(g, uc);
  g.continueAfterReveal(g.hostId);
  eq(g.phase, PHASES.GAMEOVER, 'kick gameover: game ended');
  const victim = g.players.find((p) => p.id !== g.hostId).id;
  const before = g.players.length;
  ok(g.kickPlayer(g.hostId, victim).ok, 'kick gameover: removal ok');
  eq(g.players.length, before - 1, 'kick gameover: seat freed after the game');
  eq(g.winner, 'civilians', 'kick gameover: the recorded winner is untouched');
}

// ===========================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
