/** Fetch Soulframe's global world state (rotating events / cooldowns).
 *
 *  api.soulframe.com/cdn/worldState.php is public and unauthenticated (same
 *  /cdn/ surface as the profile endpoint). It carries the timed, rotating
 *  content - Conquests (the siege/world-boss-style events) and Descents - each
 *  with an Activation and Expiry. The dashboard turns those timestamps into
 *  live countdowns; this module just fetches, caches, and normalizes them.
 */

const ENDPOINT = "https://api.soulframe.com/cdn/worldState.php";
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const CACHE_MS = 5 * 60 * 1000;

export interface WorldEvent {
  kind: "conquest" | "descent" | "goal";
  /** Stable id for display/keying (e.g. the Conquest type). */
  id: string;
  /** Unix seconds. */
  activation: number | null;
  expiry: number | null;
}

export interface WorldState {
  serverTime: number; // unix seconds
  events: WorldEvent[];
}

/** DE encodes times as { $date: { $numberLong: "<ms>" } } or a bare number. */
function toSeconds(value: unknown): number | null {
  if (typeof value === "number") return value > 1e11 ? Math.floor(value / 1000) : value;
  if (value && typeof value === "object") {
    const date = (value as { $date?: { $numberLong?: string } }).$date;
    if (date?.$numberLong) return Math.floor(Number(date.$numberLong) / 1000);
  }
  return null;
}

/** Skip permanent/sentinel windows (years-long) - they are flags, not timers. */
function isRealWindow(expiry: number | null, now: number): boolean {
  return expiry !== null && expiry > now && expiry - now < 400 * 24 * 3600;
}

let memo: { at: number; state: WorldState } | null = null;

export async function getWorldState(fetchImpl: typeof fetch = fetch): Promise<WorldState> {
  if (memo && Date.now() - memo.at < CACHE_MS) return memo.state;

  const res = await fetchImpl(ENDPOINT, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`worldState failed (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;

  const serverTime = toSeconds(raw.Time) ?? Math.floor(Date.now() / 1000);
  const events: WorldEvent[] = [];

  const readList = (key: string, kind: WorldEvent["kind"], idOf: (e: Record<string, unknown>, i: number) => string) => {
    const list = raw[key];
    if (!Array.isArray(list)) return;
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== "object") return;
      const e = entry as Record<string, unknown>;
      const activation = toSeconds(e.Activation);
      const expiry = toSeconds(e.Expiry);
      if (kind !== "goal" && !isRealWindow(expiry, serverTime)) return; // only live/rotating
      events.push({ kind, id: idOf(e, i), activation, expiry });
    });
  };

  readList("Conquests", "conquest", (e) => String(e.Type ?? e.Tag ?? "Conquest"));
  readList("Descents", "descent", (_e, i) => `Descent ${i + 1}`);

  const state: WorldState = { serverTime, events: events.sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0)) };
  memo = { at: Date.now(), state };
  return state;
}
