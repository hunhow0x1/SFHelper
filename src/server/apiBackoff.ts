import type { RequestEntry } from "./requestLog";

const FIRST_PAUSE_MS = 15 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

let pausedUntil = 0;
let pauseMs = 0;

export function apiPausedUntil(now = Date.now()): number | null {
  return now < pausedUntil ? pausedUntil : null;
}

export function noteApiRefused(now = Date.now()): number {
  pauseMs = pauseMs ? Math.min(pauseMs * 2, MAX_PAUSE_MS) : FIRST_PAUSE_MS;
  pausedUntil = now + pauseMs;
  return pausedUntil;
}

export function noteApiAccepted(): void {
  pauseMs = 0;
  pausedUntil = 0;
}

export function restoreApiBackoff(history: Pick<RequestEntry, "at" | "status" | "empty">[]): void {
  noteApiAccepted();
  for (const e of [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (e.status === 403 || e.status === 429) noteApiRefused(Date.parse(e.at));
    else if (e.status !== null && e.status >= 200 && e.status < 300 && !e.empty) noteApiAccepted();
  }
}

export function pausedMessage(until: number, status?: number): string {
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Soulframe is refusing requests from this network${status ? ` (${status})` : ""}. Pausing until ${at}.`;
}
