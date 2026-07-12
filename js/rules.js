// ============================================================================
// rules.js — ALL Undercover rule constants + pure logic. Start here.
//
// No networking, no DOM, no state mutation of engine objects. Everything here
// is deterministic given its inputs (an optional rng is threaded through for
// testability). The host engine (state.js) delegates every rule query here so
// the rules live in exactly one place.
// ============================================================================

import { pairsForCategory } from './words.js';

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;

export const ROLES = {
  CIVILIAN: 'civilian',
  UNDERCOVER: 'undercover',
  MRWHITE: 'mrwhite',
};

export const PHASES = {
  LOBBY: 'lobby',
  ROLE_REVEAL: 'roleReveal',
  DESCRIBE: 'describe',
  VOTE: 'vote',
  REVEAL: 'reveal',
  WHITE_GUESS: 'whiteGuess',
  GAMEOVER: 'gameover',
};

// Tie-break modes for the elimination vote — the host picks one at game start.
export const TIE_BREAK = {
  RUNOFF: 'runoff',              // re-vote among the tied players (repeatable)
  RUNOFF_RANDOM: 'runoffRandom', // one runoff, then eliminate at random
  NONE: 'none',                  // a tie means nobody is eliminated this round
};

// Optional per-turn describe timer. When the host enables it, each speaker gets
// `timerSeconds` to give their clue; on expiry the host auto-advances the turn.
export const TIMER = {
  MIN: 15,
  MAX: 90,
  STEP: 5,
  DEFAULT: 30,
};

/** Snap a requested timer duration to the allowed [MIN, MAX] range and step. */
export function clampTimerSeconds(v) {
  let s = Math.round(Number(v) / TIMER.STEP) * TIMER.STEP;
  if (!Number.isFinite(s)) s = TIMER.DEFAULT;
  return Math.min(TIMER.MAX, Math.max(TIMER.MIN, s));
}

// Default (undercover, mrwhite) counts by player count. Civilians fill the
// rest. Every default keeps civilians a strict majority so the game can't be
// won on parity at the opening. Host can override within validation limits.
export const DEFAULT_ROLE_TABLE = {
  4:  { undercover: 1, mrwhite: 0 },
  5:  { undercover: 1, mrwhite: 1 },
  6:  { undercover: 1, mrwhite: 1 },
  7:  { undercover: 2, mrwhite: 1 },
  8:  { undercover: 2, mrwhite: 1 },
  9:  { undercover: 2, mrwhite: 1 },
  10: { undercover: 3, mrwhite: 1 },
  11: { undercover: 3, mrwhite: 1 },
  12: { undercover: 3, mrwhite: 1 },
  13: { undercover: 3, mrwhite: 1 },
  14: { undercover: 4, mrwhite: 1 },
  15: { undercover: 4, mrwhite: 1 },
  16: { undercover: 4, mrwhite: 1 },
  17: { undercover: 5, mrwhite: 1 },
  18: { undercover: 5, mrwhite: 1 },
  19: { undercover: 5, mrwhite: 1 },
  20: { undercover: 6, mrwhite: 1 },
};

export function defaultRoleConfig(playerCount) {
  const t = DEFAULT_ROLE_TABLE[playerCount];
  return t ? { ...t } : { undercover: 1, mrwhite: 0 };
}

/**
 * Validate a role config for a given player count.
 * Returns { ok, error, civilian, undercover, mrwhite }.
 * The core constraint is that civilians must strictly outnumber the combined
 * non-civilian side, otherwise the undercover side would already have won on
 * the parity rule before the first vote.
 */
export function validateRoleConfig(cfg, playerCount) {
  const undercover = Number(cfg && cfg.undercover);
  const mrwhite = Number(cfg && cfg.mrwhite);
  const base = { ok: false, civilian: 0, undercover: undercover || 0, mrwhite: mrwhite || 0 };

  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    return { ...base, error: `Need ${MIN_PLAYERS}–${MAX_PLAYERS} players.` };
  }
  if (!Number.isInteger(undercover) || undercover < 1) {
    return { ...base, error: 'At least 1 undercover is required.' };
  }
  if (!Number.isInteger(mrwhite) || mrwhite < 0 || mrwhite > 1) {
    return { ...base, error: 'Mr. White must be 0 or 1.' };
  }
  const civilian = playerCount - undercover - mrwhite;
  if (civilian < 1) {
    return { ...base, error: 'There must be at least 1 civilian.' };
  }
  if (civilian <= undercover + mrwhite) {
    return {
      ...base, civilian,
      error: 'Civilians must outnumber the undercover side.',
    };
  }
  return { ok: true, error: '', civilian, undercover, mrwhite };
}

/**
 * The largest undercover count that still validates for a player count and a
 * given Mr. White setting. Used to bound the lobby stepper.
 */
export function maxUndercover(playerCount, mrwhite) {
  let u = 1;
  while (validateRoleConfig({ undercover: u + 1, mrwhite }, playerCount).ok) u++;
  return u;
}

/** Build the flat role deck (one entry per player), unshuffled. */
export function buildRoleDeck(playerCount, cfg) {
  const deck = [];
  for (let i = 0; i < cfg.undercover; i++) deck.push(ROLES.UNDERCOVER);
  for (let i = 0; i < cfg.mrwhite; i++) deck.push(ROLES.MRWHITE);
  while (deck.length < playerCount) deck.push(ROLES.CIVILIAN);
  return deck;
}

/** In-place Fisher–Yates shuffle. rng() should yield [0,1). */
export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick a random word pair from a category (or the whole bank). */
export function pickWordPair(categoryId, rng = Math.random) {
  const pool = pairsForCategory(categoryId);
  const chosen = pool[Math.floor(rng() * pool.length)];
  return chosen.pair; // [wordA, wordB]
}

/**
 * Randomly assign the two words of a pair to the civilian and undercover sides
 * so neither word is predictably "the majority word".
 */
export function assignWordPair(pair, rng = Math.random) {
  const flip = rng() < 0.5;
  const civilianWord = flip ? pair[0] : pair[1];
  const undercoverWord = flip ? pair[1] : pair[0];
  return { civilianWord, undercoverWord };
}

/** The secret word a role receives. Mr. White receives none (null). */
export function wordForRole(role, words) {
  if (role === ROLES.CIVILIAN) return words.civilianWord;
  if (role === ROLES.UNDERCOVER) return words.undercoverWord;
  return null;
}

/**
 * Winner check from the currently-living players (each { role }).
 *   - civilians win when every non-civilian has been eliminated.
 *   - the undercover side (undercover + Mr. White) wins on parity: the moment
 *     living non-civilians equal or outnumber living civilians.
 * Returns 'civilians' | 'undercover' | null (game continues).
 */
export function checkWinner(alive) {
  const civ = alive.filter((p) => p.role === ROLES.CIVILIAN).length;
  const nonCiv = alive.length - civ;
  if (nonCiv === 0) return 'civilians';
  if (nonCiv >= civ) return 'undercover';
  return null;
}

/**
 * Choose the player who describes first. Mr. White never opens a round (they
 * have no word to riff on), so we pick a random living non-white player. If
 * only Mr. White remains alive (shouldn't happen mid-game), fall back to any
 * living player. `alive` is an array of { id, role }.
 */
export function chooseStarter(alive, rng = Math.random) {
  const pool = alive.filter((p) => p.role !== ROLES.MRWHITE);
  const from = pool.length ? pool : alive;
  if (!from.length) return null;
  return from[Math.floor(rng() * from.length)].id;
}

// --- Display helpers -------------------------------------------------------
export function describeRole(role) {
  switch (role) {
    case ROLES.UNDERCOVER:
      return {
        id: role, name: 'Undercover', color: 'uc',
        blurb: 'Your word is close to the civilians’ — but not the same. Blend in, sow doubt, and survive to parity.',
      };
    case ROLES.MRWHITE:
      return {
        id: role, name: 'Mr. White', color: 'white',
        blurb: 'You have no word. Bluff from what others say. If you’re voted out you get one guess at the civilians’ word — nail it and you steal the win.',
      };
    default:
      return {
        id: ROLES.CIVILIAN, name: 'Civilian', color: 'civ',
        blurb: 'You share a secret word with the other civilians. Describe it without giving it away, and root out the impostors.',
      };
  }
}

export function roleColorClass(role) {
  if (role === ROLES.UNDERCOVER) return 'uc';
  if (role === ROLES.MRWHITE) return 'white';
  return 'civ';
}

// --- Word-guess matching (Mr. White) ---------------------------------------
/** Loose normalisation for comparing a typed guess to the civilian word. */
export function normalizeWord(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function wordsMatch(a, b) {
  const na = normalizeWord(a);
  return na.length > 0 && na === normalizeWord(b);
}
