/** Shared back-off for api.soulframe.com.
 *
 *  A 403/429 means DE is refusing requests from this network, and every
 *  further request while refused can extend the block. So once anything (the
 *  profile lookup, or the desktop app's inventory import) is refused, ALL
 *  requests to DE pause: 15 minutes at first, doubling on each repeat refusal
 *  up to an hour, and reset by the next accepted request.
 */

const FIRST_PAUSE_MS = 15 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

let pausedUntil = 0;
let pauseMs = 0;

/** When requests may resume (ms epoch), or null if they're allowed now. */
export function apiPausedUntil(now = Date.now()): number | null {
  return now < pausedUntil ? pausedUntil : null;
}

/** Record a refusal; returns when requests may resume. */
export function noteApiRefused(now = Date.now()): number {
  pauseMs = pauseMs ? Math.min(pauseMs * 2, MAX_PAUSE_MS) : FIRST_PAUSE_MS;
  pausedUntil = now + pauseMs;
  return pausedUntil;
}

/** Record an accepted request: the block has cleared. */
export function noteApiAccepted(): void {
  pauseMs = 0;
  pausedUntil = 0;
}

/** "Soulframe is refusing requests (403). Pausing until 14:05." */
export function pausedMessage(until: number, status?: number): string {
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Soulframe is refusing requests from this network${status ? ` (${status})` : ""}. Pausing until ${at}.`;
}
