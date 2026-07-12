// Correctness harness for the pure rules + host engine. No DOM, no network.
// Run: node scripts/test-engine.mjs
import {
  MIN_PLAYERS, MAX_PLAYERS, ROLES, TIE_BREAK,
  defaultRoleConfig, validateRoleConfig, maxUndercover, buildRoleDeck, shuffle,
  assignWordPair, wordForRole, checkWinner, chooseStarter, wordsMatch,
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
