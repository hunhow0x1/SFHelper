/** Local dashboard server.
 *
 *  Runs on your machine alongside Soulframe. It serves the dashboard page and,
 *  on request, fetches your public profile server-side (so the browser never
 *  hits api.soulframe.com directly and there is no CORS problem). It only ever
 *  reads the public, unauthenticated profile endpoint - no credentials, no
 *  game process. Everything the memory helper would add is separate.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { snapshotFromProfile, type ProfileSnapshot } from "../account/providers/profilePayload";
import { discoverAccountId, rememberAccountId } from "./accountId";
import { getNames } from "./names";
import { getInventory, type InventoryView } from "./inventory";
import { recordPickups } from "./pickups";
import { recordTrades, tradedIds } from "./trades";
import { getSettings, updateSettings } from "./settings";
import { recordStanding, dailyCaps } from "./standing";
import { getImportStatus } from "./importStatus";
import { getUpdateStatus, requestUpdateAction } from "./updateStatus";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "./apiBackoff";
import { appFile, dataDir } from "./paths";
import { getEnemyNamer } from "./enemies";
import { gameBeingRefused, gameRefusedMessage } from "./gameLog";
import { getEnvoyRank } from "./envoyRank";
import { acknowledgeAvakot, getAvakot } from "./avakot";
import { getDiscoveries } from "./discoveries";
import { withAgariNames } from "./timers";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
/** Ask DE for the public profile at most this often (the page polls this
 *  server every 30 s; standing doesn't change faster than this matters). */
const MIN_FETCH_INTERVAL_MS = 120_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

interface CacheEntry {
  at: number;
  snapshot: ProfileSnapshot;
  /** Why the last attempt couldn't get a fresh copy, if it couldn't. */
  error: string | null;
}
const cache = new Map<string, CacheEntry>();

/** The last profile is also kept on disk, so a fresh start while DE can't be
 *  asked still shows something (marked as an older copy). */
const savedProfilePath = (accountId: string) => appFile(`profile-${accountId}.json`);

async function loadSavedProfile(accountId: string): Promise<CacheEntry | null> {
  try {
    const saved = JSON.parse(await readFile(savedProfilePath(accountId), "utf8")) as { snapshot?: ProfileSnapshot };
    // at 0: stale, so the next request still tries DE first.
    return saved.snapshot ? { at: 0, snapshot: saved.snapshot, error: null } : null;
  } catch {
    return null;
  }
}

async function saveProfile(accountId: string, snapshot: ProfileSnapshot): Promise<void> {
  const path = savedProfilePath(accountId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ snapshot })}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** The public profile, fetched at most every MIN_FETCH_INTERVAL_MS. When DE
 *  can't be asked (requests paused after a refusal, or the game itself being
 *  refused) or the lookup fails, the last copy is served with the reason, so
 *  the rest of the dashboard keeps updating from local data. */
async function getProfile(accountId: string): Promise<{ snapshot: ProfileSnapshot; error: string | null }> {
  const cached = cache.get(accountId) ?? (await loadSavedProfile(accountId));
  if (cached && Date.now() - cached.at < MIN_FETCH_INTERVAL_MS) return { snapshot: cached.snapshot, error: cached.error };
  try {
    const snapshot = await fetchProfile(accountId);
    cache.set(accountId, { at: Date.now(), snapshot, error: null });
    await saveProfile(accountId, snapshot).catch(() => {});
    return { snapshot, error: null };
  } catch (err) {
    if (!cached) throw err;
    // Wait a full interval before trying again, whatever went wrong.
    const error = (err as Error).message;
    cache.set(accountId, { at: Date.now(), snapshot: cached.snapshot, error });
    return { snapshot: cached.snapshot, error };
  }
}

async function fetchProfile(accountId: string): Promise<ProfileSnapshot> {
  const paused = apiPausedUntil();
  if (paused) throw new Error(pausedMessage(paused));
  const refused = await gameBeingRefused();
  if (refused) throw new Error(gameRefusedMessage(refused));

  const response = await fetch(PROFILE_ENDPOINT + encodeURIComponent(accountId), {
    headers: { "user-agent": USER_AGENT },
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(pausedMessage(noteApiRefused(), response.status));
  }
  if (!response.ok) throw new Error(`Profile lookup failed (${response.status}).`);
  noteApiAccepted();

  const text = await response.text();
  if (text.trim() === "") throw new Error("No profile for that account id.");
  return snapshotFromProfile(JSON.parse(text) as unknown, new Date().toISOString());
}

async function readFromDir(base: string, rel: string): Promise<Buffer | null> {
  const full = normalize(join(base, rel));
  if (!full.startsWith(base)) return null; // path-traversal guard
  try {
    return await readFile(full);
  } catch {
    return null;
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Prefer the writable data overlay (launch-built JSON, written there because
  // the packaged app's assets are read-only), then the bundled assets.
  const overlay = dataDir();
  const body = (overlay ? await readFromDir(overlay, rel) : null) ?? (await readFromDir(PUBLIC_DIR, rel));
  if (!body) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = rel.slice(rel.lastIndexOf("."));
  res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Names resolve from the hostable endpoint (or cache/bundle), not the static file.
  if (url.pathname === "/names.json") {
    sendJson(res, 200, await getNames());
    return;
  }

  // Report the auto-discovered account id (saved config, or Little Genius).
  if (url.pathname === "/api/account" && req.method === "GET") {
    const found = await discoverAccountId();
    sendJson(res, 200, found ?? { accountId: null, source: null });
    return;
  }

  // Remember an id the user entered, so future launches resolve it for them.
  if (url.pathname === "/api/account" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { accountId } = JSON.parse(body || "{}") as { accountId?: string };
      if (!accountId || !ACCOUNT_ID_RE.test(accountId)) {
        sendJson(res, 400, { error: "Enter your 24-character account id." });
        return;
      }
      await rememberAccountId(accountId);
      sendJson(res, 200, { accountId, source: "config" });
    } catch {
      sendJson(res, 400, { error: "Invalid request." });
    }
    return;
  }

  // What the desktop app's memory import is doing (null outside the app).
  if (url.pathname === "/api/import-status") {
    sendJson(res, 200, getImportStatus());
    return;
  }

  // Whether DE is refusing requests: SFHelper's (paused after a 403/429) or
  // the game's own (from its log). The page shows a banner while either holds.
  if (url.pathname === "/api/connection") {
    sendJson(res, 200, { pausedUntil: apiPausedUntil(), gameRefused: await gameBeingRefused() });
    return;
  }

  // The desktop app's self-update (null outside the app), and its buttons.
  if (url.pathname === "/api/update" && req.method === "GET") {
    sendJson(res, 200, getUpdateStatus());
    return;
  }
  if (url.pathname === "/api/update" && req.method === "POST") {
    // JSON only: another site can't send that cross-origin without a preflight
    // this server never answers.
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(res, 415, { error: "Expected JSON." });
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { action } = JSON.parse(body || "{}") as { action?: unknown };
      if (action !== "check" && action !== "install") {
        sendJson(res, 400, { error: "Unknown action." });
        return;
      }
      if (!requestUpdateAction(action)) {
        sendJson(res, 409, { error: "Updates aren't available here." });
        return;
      }
      sendJson(res, 200, getUpdateStatus());
    } catch {
      sendJson(res, 400, { error: "Invalid request." });
    }
    return;
  }

  // App preferences (e.g. the Moonsteel notification toggle).
  if (url.pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, await getSettings());
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body || "{}") as Record<string, unknown>;
      const settings = await updateSettings(patch);
      if ("avakotWatch" in patch) await acknowledgeAvakot(settings.avakotWatch);
      sendJson(res, 200, settings);
    } catch {
      sendJson(res, 400, { error: "Invalid request." });
    }
    return;
  }

  // Avakot's last known stock (fetched by the desktop app), the offer history
  // and the user's stars.
  if (url.pathname === "/api/avakot" && req.method === "GET") {
    const { avakotWatch, avakotNotify } = await getSettings();
    sendJson(res, 200, { ...(await getAvakot()), watch: avakotWatch, notify: avakotNotify });
    return;
  }

  if (url.pathname === "/api/profile") {
    const accountId = url.searchParams.get("accountId") ?? "";
    if (!ACCOUNT_ID_RE.test(accountId)) {
      sendJson(res, 400, { error: "Enter your 24-character account id." });
      return;
    }
    try {
      const { snapshot: snap, error: profileError } = await getProfile(accountId);
      const enemyName = await getEnemyNamer();
      const { PlayerLevel, ...profileCurrencies } = snap.currencies;
      // Overlay a local inventory (memory helper / DE data request) when present:
      // it is the only source of currencies and owned-item counts.
      const inventory = await getInventory();
      const ownedCounts = new Map(inventory?.items.map((i) => [i.key, i.count]) ?? []);
      // Owned weapons + affinity: from the inventory when present (complete), else
      // from the profile's leveled items (its `rank` field carries the XP).
      const weapons =
        inventory?.weapons ??
        snap.items
          .filter((it) => it.category === "weapon" && typeof it.rank === "number")
          .map((it) => ({ key: it.key, xp: it.rank ?? 0, slot: "Melee" as const, craftwork: null, tempers: [], id: null }));
      // Owned Pacts (souls) + affinity, same source priority as weapons.
      const pacts =
        inventory?.pacts ??
        snap.items
          .filter((it) => it.category === "soul" && typeof it.rank === "number")
          .map((it) => ({ key: it.key, xp: it.rank ?? 0 }));
      const { trades, pickups } = await recordHistory(inventory);
      // Standing earned since the daily reset, per faction (tracked over time).
      const standingNow: Record<string, number> = {};
      for (const p of snap.progression) {
        if (p.kind === "affiliation" && typeof p.xp === "number") standingNow[p.key.replace(/^affiliation:/, "")] = p.xp;
      }
      const standingToday = Object.keys(standingNow).length ? await recordStanding(standingNow) : null;
      // Remaining daily caps: the profile's, or the inventory's if it was read
      // since today's reset and has counted down further.
      const lowest = (a: number | null, b: number | null | undefined) =>
        a == null ? (b ?? null) : b == null ? a : Math.min(a, b);
      const resetMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const invDaily = inventory && Date.parse(inventory.updatedAt) >= resetMs ? inventory.daily : null;
      const caps = dailyCaps(
        PlayerLevel ?? null,
        {
          affiliation: lowest(snap.daily.affiliation, invDaily?.affiliation),
          affiliationOde: lowest(snap.daily.affiliationOde, invDaily?.affiliationOde),
        },
        standingToday,
      );
      sendJson(res, 200, {
        account: snap.account,
        level: PlayerLevel ?? null,
        items: snap.items.map((it) =>
          ownedCounts.has(it.key) ? { ...it, count: ownedCounts.get(it.key) } : it,
        ),
        progression: snap.progression,
        // Enemy kill stats with each type's in-game name ("Sinecure Soldier").
        stats: { ...snap.stats, enemies: snap.stats.enemies.map((e) => ({ ...e, name: typeof e.type === "string" ? enemyName(e.type) : null })) },
        daily: snap.daily,
        standingToday, // { since, exact, total, factions: { Tag: earned } } since 00:00 UTC
        dailyCaps: caps, // { cap, remaining, odeCap, odeRemaining, earned, exact }
        importStatus: getImportStatus(), // desktop app's memory import, or null
        currencies: inventory ? inventory.currencies : profileCurrencies,
        owned: Object.fromEntries(ownedCounts), // ItemType -> owned count (for tokens, etc.)
        weapons, // [{ key, xp, slot, craftwork, tempers }] for the leveling tracker
        pacts, // [{ key, xp }] owned pacts (souls) for the leveling tracker
        mastery: inventory?.mastery ?? null, // ItemType -> most XP ever reached (XPInfo), or null without an inventory
        // Envoy (Mastery) Rank: exact rank, the patch's max, and progress (part of it from the game log).
        envoyRank: PlayerLevel != null ? await getEnvoyRank(accountId, PlayerLevel, inventory?.mastery ?? null) : null,
        timers: inventory ? await withAgariNames(inventory.timers) : [], // [{ tag, kind, name, ready, expiry }] the game's own timers (Agari respawns...)
        discoveries: inventory ? await getDiscoveries(inventory.loreScans) : null, // { places: [{ key, name, memories, found, discovered }], maps }
        temperProgress: inventory?.temperProgress ?? [], // Tuvalkane temper learning
        pickups, // [{ key, craftwork, tempers, xp, at, when, whenSource }] weapon pickup history
        trades, // { history: [{ at, after, count, received, given, dracs }], remaining, max }, or null
        builds: inventory?.builds ?? [],
        totems: inventory?.totems ?? null, // [{ id, type, rank, virtue, grip, equippedOn }] owned totems
        inventory: inventory ? { source: inventory.source, updatedAt: inventory.updatedAt, itemCount: inventory.items.length } : null,
        capturedAt: snap.capturedAt,
        profileError, // why the profile above is an older copy, or null
      });
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
}

/** Trade history and picked-up-weapon history (inventory diffs by ItemId),
 *  only when there's a real inventory to diff against. Runs on each dashboard
 *  refresh, and in the desktop app right after each import, so pickups and
 *  Moonsteel notifications don't wait for the page. Trades go first so a
 *  weapon received in a trade isn't counted as a pickup. */
export async function recordHistory(inventory?: InventoryView | null) {
  if (inventory === undefined) inventory = await getInventory();
  if (!inventory) return { trades: null, pickups: [] };
  const trades = await recordTrades(inventory.holdings, inventory.updatedAt);
  const pickups = await recordPickups(inventory.weaponInstances, inventory.acquisition, tradedIds(trades.history));
  return { trades, pickups };
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Start the dashboard server. Resolves once it is listening. */
export function startServer(port = Number(process.env.SFHELPER_PORT ?? 4317)): Promise<RunningServer> {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      const actual = (server.address() as { port: number }).port;
      const url = `http://localhost:${actual}`;
      console.log(`SFHelper dashboard: ${url}`);
      resolve({
        port: actual,
        url,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
