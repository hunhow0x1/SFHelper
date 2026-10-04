/** Local dashboard server.
 *
 *  Runs on your machine alongside Soulframe. It serves the dashboard page and,
 *  on request, fetches your public profile server-side (so the browser never
 *  hits api.soulframe.com directly and there is no CORS problem). It only ever
 *  reads the public, unauthenticated profile endpoint - no credentials, no
 *  game process. Everything the memory helper would add is separate.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { snapshotFromProfile, type ProfileSnapshot } from "../account/providers/profilePayload";
import { discoverAccountId, rememberAccountId } from "./accountId";
import { getNames } from "./names";
import { getInventory } from "./inventory";
import { recordPickups } from "./pickups";
import { getSettings, updateSettings } from "./settings";
import { recordStanding, dailyCaps } from "./standing";
import { getImportStatus } from "./importStatus";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "./apiBackoff";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
// Launch-built data (totems.json, runes.json) is written to a writable dir since
// the packaged app's assets are read-only. Files here override the bundled ones.
const DATA_DIR = process.env.SFHELPER_DATA_DIR ? normalize(process.env.SFHELPER_DATA_DIR) : null;
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
const MIN_FETCH_INTERVAL_MS = 15_000;

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
}
const cache = new Map<string, CacheEntry>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** Fetch and parse a profile, with a short cache so rapid polling from the page
 *  does not hammer DE's server. On 403/429 every request to DE pauses (see
 *  apiBackoff) - the page keeps polling, but nothing reaches DE until then. */
async function getProfile(accountId: string): Promise<ProfileSnapshot> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at < MIN_FETCH_INTERVAL_MS) return cached.snapshot;
  const paused = apiPausedUntil();
  if (paused) throw new Error(pausedMessage(paused));

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
  const snapshot = snapshotFromProfile(JSON.parse(text) as unknown, new Date().toISOString());
  cache.set(accountId, { at: Date.now(), snapshot });
  return snapshot;
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
  // Prefer the writable data overlay (launch-built JSON), then the bundled assets.
  const body = (DATA_DIR ? await readFromDir(DATA_DIR, rel) : null) ?? (await readFromDir(PUBLIC_DIR, rel));
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

  // App preferences (e.g. the Moonsteel notification toggle).
  if (url.pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, await getSettings());
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      sendJson(res, 200, await updateSettings(JSON.parse(body || "{}") as Record<string, unknown>));
    } catch {
      sendJson(res, 400, { error: "Invalid request." });
    }
    return;
  }

  if (url.pathname === "/api/profile") {
    const accountId = url.searchParams.get("accountId") ?? "";
    if (!ACCOUNT_ID_RE.test(accountId)) {
      sendJson(res, 400, { error: "Enter your 24-character account id." });
      return;
    }
    try {
      const snap = await getProfile(accountId);
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
      // Picked-up-weapon history (inventory diff by ItemId). Only when we have a
      // real inventory to diff against.
      const pickups = inventory ? await recordPickups(inventory.weaponInstances, inventory.acquisition) : [];
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
        stats: snap.stats,
        daily: snap.daily,
        standingToday, // { since, exact, total, factions: { Tag: earned } } since 00:00 UTC
        dailyCaps: caps, // { cap, remaining, odeCap, odeRemaining, earned, exact }
        importStatus: getImportStatus(), // desktop app's memory import, or null
        currencies: inventory ? inventory.currencies : profileCurrencies,
        owned: Object.fromEntries(ownedCounts), // ItemType -> owned count (for tokens, etc.)
        weapons, // [{ key, xp, slot, craftwork, tempers }] for the leveling tracker
        pacts, // [{ key, xp }] owned pacts (souls) for the leveling tracker
        temperProgress: inventory?.temperProgress ?? [], // Tuvalkane temper learning
        pickups, // [{ key, craftwork, tempers, xp, at, when, whenSource }] weapon pickup history
        builds: inventory?.builds ?? [],
        totems: inventory?.totems ?? null, // [{ id, type, rank, virtue, grip, equippedOn }] owned totems
        inventory: inventory ? { source: inventory.source, updatedAt: inventory.updatedAt, itemCount: inventory.items.length } : null,
        capturedAt: snap.capturedAt,
      });
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
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
