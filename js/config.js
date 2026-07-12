// ============================================================================
// config.js — optional authoritative-server hosting.
//
// Undercover is peer-to-peer FIRST: with the two constants below left empty the
// app behaves exactly as before (host in your browser, WebRTC over the LAN).
// Fill them in to ALSO offer a "Host on server" option that runs the game on a
// shared always-on server — handy when players aren't on the same Wi-Fi or a
// phone can't keep a browser tab alive as the host.
//
// The client boot does a quick health probe (SERVER_HEALTH). Only if it answers
// does the "Host on server" button appear; joining tries the server first and
// silently falls back to peer-to-peer for the same code. Either transport can be
// unavailable without breaking the other — server mode is purely additive.
//
//   SERVER_URL     WebSocket base. TRAILING SLASH REQUIRED (the reverse proxy's
//                  path route does not match a bare "/undercover").
//   SERVER_HEALTH  Plain-HTTP liveness probe, returns { ok: true, ... }.
//
// Set BOTH to '' (empty) to hard-disable server mode.
// ============================================================================

export const SERVER_URL = 'wss://pi.tail360216.ts.net/undercover/';
export const SERVER_HEALTH = 'https://pi.tail360216.ts.net/undercover/health';

/** True when a server endpoint is configured at all (mode may still be off if
 *  the health probe fails at boot). */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
