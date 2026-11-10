import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep } from "node:path";
import { snapshotFromProfile, type ProfileSnapshot } from "../account/providers/profilePayload";
import { discoverAccountId, rememberAccountId } from "./accountId";
import { getNames } from "./names";
import { getInventory, type InventoryView } from "./inventory";
import { pickupHistory, recordPickups } from "./pickups";
import { recordTrades, tradedIds, tradeHistory } from "./trades";
import { exportHistory, historyFileName, importHistory } from "./history";
import { getSettings, updateSettings } from "./settings";
import { recordStanding, dailyCaps, preludes17Caps } from "./standing";
import { getDataRefreshedAt, getImportStatus } from "./importStatus";
import { getUpdateStatus, requestUpdateAction } from "./updateStatus";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "./apiBackoff";
import { appFile, dataDir } from "./paths";
import { getEnemyNamer } from "./enemies";
import { gameBeingRefused, gameRefusedMessage, loggedCollector } from "./gameLog";
import { getEnvoyRank } from "./envoyRank";
import { getRoster } from "./roster";
import { virtuePoints } from "./loadouts";
import { acknowledgeAvakot, getAvakot } from "./avakot";
import { getDiscoveries } from "./discoveries";
import { userAgent } from "./userAgent";
import { tracked } from "./requestLog";
import { withAgariNames, withCollector, withStarred } from "./timers";
import { writeFileAtomic } from "./files";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
const MIN_FETCH_INTERVAL_MS = 120_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const HOST = "127.0.0.1";

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
  error: string | null;
}
const cache = new Map<string, CacheEntry>();

const savedProfilePath = (accountId: string) => appFile(`profile-${accountId}.json`);

async function loadSavedProfile(accountId: string): Promise<CacheEntry | null> {
  try {
    const saved = JSON.parse(await readFile(savedProfilePath(accountId), "utf8")) as { snapshot?: ProfileSnapshot };
    return saved.snapshot ? { at: 0, snapshot: saved.snapshot, error: null } : null;
  } catch {
    return null;
  }
}

async function saveProfile(accountId: string, snapshot: ProfileSnapshot): Promise<void> {
  const path = savedProfilePath(accountId);
  await writeFileAtomic(path, `${JSON.stringify({ snapshot })}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

const inflight = new Map<string, Promise<{ snapshot: ProfileSnapshot; error: string | null }>>();

function getProfile(accountId: string): Promise<{ snapshot: ProfileSnapshot; error: string | null }> {
  let run = inflight.get(accountId);
  if (!run) {
    run = loadProfile(accountId).finally(() => inflight.delete(accountId));
    inflight.set(accountId, run);
  }
  return run;
}

async function loadProfile(accountId: string): Promise<{ snapshot: ProfileSnapshot; error: string | null }> {
  const cached = cache.get(accountId) ?? (await loadSavedProfile(accountId));
  if (cached && Date.now() - cached.at < MIN_FETCH_INTERVAL_MS) return { snapshot: cached.snapshot, error: cached.error };
  try {
    const snapshot = await fetchProfile(accountId);
    cache.set(accountId, { at: Date.now(), snapshot, error: null });
    await saveProfile(accountId, snapshot).catch(() => {});
    return { snapshot, error: null };
  } catch (err) {
    if (!cached) throw err;
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

  const response = await tracked("profile")(PROFILE_ENDPOINT + encodeURIComponent(accountId), {
    headers: { "user-agent": userAgent() },
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
  const root = normalize(base);
  const full = normalize(join(root, rel));
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  try {
    return await readFile(full);
  } catch {
    return null;
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
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

async function readJsonBody(req: IncomingMessage, res: ServerResponse, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Expected JSON." });
    return null;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) {
      sendJson(res, 413, { error: "Request too large." });
      req.destroy();
      return null;
    }
  }
  try {
    const parsed = JSON.parse(body || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
  }
  sendJson(res, 400, { error: "Invalid request." });
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse, hosts: Set<string>): Promise<void> {
  if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/names.json") {
    sendJson(res, 200, await getNames());
    return;
  }

  if (url.pathname === "/roster.json") {
    sendJson(res, 200, await getRoster());
    return;
  }

  if (url.pathname === "/api/account" && req.method === "GET") {
    const found = await discoverAccountId();
    sendJson(res, 200, found ?? { accountId: null, source: null });
    return;
  }

  if (url.pathname === "/api/account" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const accountId = body.accountId;
    if (typeof accountId !== "string" || !ACCOUNT_ID_RE.test(accountId)) {
      sendJson(res, 400, { error: "Enter your 24-character account id." });
      return;
    }
    await rememberAccountId(accountId);
    sendJson(res, 200, { accountId, source: "config" });
    return;
  }

  if (url.pathname === "/api/history/export" && req.method === "GET") {
    const now = new Date();
    const text = `${JSON.stringify(await exportHistory(now), null, 2)}\n`;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${historyFileName(now)}"`,
    });
    res.end(text);
    return;
  }

  if (url.pathname === "/api/history/import" && req.method === "POST") {
    const body = await readJsonBody(req, res, MAX_IMPORT_BYTES);
    if (!body) return;
    try {
      sendJson(res, 200, await importHistory(body));
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/import-status") {
    sendJson(res, 200, getImportStatus());
    return;
  }

  if (url.pathname === "/api/connection") {
    sendJson(res, 200, { pausedUntil: apiPausedUntil(), gameRefused: await gameBeingRefused(), dataAt: getDataRefreshedAt() });
    return;
  }

  if (url.pathname === "/api/update" && req.method === "GET") {
    sendJson(res, 200, getUpdateStatus());
    return;
  }
  if (url.pathname === "/api/update" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const action = body.action;
    if (action !== "check" && action !== "install") {
      sendJson(res, 400, { error: "Unknown action." });
      return;
    }
    if (!requestUpdateAction(action)) {
      sendJson(res, 409, { error: "Updates aren't available here." });
      return;
    }
    sendJson(res, 200, getUpdateStatus());
    return;
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, await getSettings());
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    const patch = await readJsonBody(req, res);
    if (!patch) return;
    const settings = await updateSettings(patch);
    if ("avakotWatch" in patch) await acknowledgeAvakot(settings.avakotWatch);
    sendJson(res, 200, settings);
    return;
  }

  if (url.pathname === "/api/avakot" && req.method === "GET") {
    const { avakotWatch, avakotNotify, avakotResetNotify } = await getSettings();
    sendJson(res, 200, { ...(await getAvakot()), watch: avakotWatch, notify: avakotNotify, resetNotify: avakotResetNotify });
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
      const inventory = await getInventory();
      const ownedCounts = new Map(inventory?.items.map((i) => [i.key, i.count]) ?? []);
      const weapons =
        inventory?.weapons ??
        snap.items
          .filter((it) => it.category === "weapon" && typeof it.rank === "number")
          .map((it) => ({ key: it.key, xp: it.rank ?? 0, slot: "Melee" as const, craftwork: null, tempers: [], id: null }));
      const pacts =
        inventory?.pacts ??
        snap.items
          .filter((it) => it.category === "soul" && typeof it.rank === "number")
          .map((it) => ({ key: it.key, xp: it.rank ?? 0 }));
      const { trades, pickups } = await recordHistory(inventory);
      const standingNow: Record<string, number> = {};
      for (const p of snap.progression) {
        if (p.kind === "affiliation" && typeof p.xp === "number") standingNow[p.key.replace(/^affiliation:/, "")] = p.xp;
      }
      const standingToday = Object.keys(standingNow).length ? await recordStanding(standingNow) : null;
      const lowest = (a: number | null, b: number | null | undefined) =>
        a == null ? (b ?? null) : b == null ? a : Math.min(a, b);
      const resetMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const invDaily = inventory && Date.parse(inventory.updatedAt) >= resetMs ? inventory.daily : null;
      const envoyRank = PlayerLevel != null ? await getEnvoyRank(accountId, PlayerLevel, inventory?.mastery ?? null, inventory?.loreScans ?? null) : null;
      const caps = dailyCaps(
        (preludes17Caps() ? PlayerLevel : envoyRank?.rank ?? PlayerLevel) ?? null,
        {
          affiliation: lowest(snap.daily.affiliation, invDaily?.affiliation),
          affiliationOde: lowest(snap.daily.affiliationOde, invDaily?.affiliationOde),
        },
        standingToday,
      );
      const builds = (inventory?.builds ?? []).map((b) =>
        envoyRank && envoyRank.rank !== envoyRank.serverRank && b.virtueShares
          ? { ...b, virtues: virtuePoints(b.virtueShares.vu, b.virtueShares.vv, envoyRank.rank) }
          : b,
      );
      sendJson(res, 200, {
        account: snap.account,
        level: envoyRank?.rank ?? PlayerLevel ?? null,
        items: snap.items.map((it) =>
          ownedCounts.has(it.key) ? { ...it, count: ownedCounts.get(it.key) } : it,
        ),
        progression: snap.progression,
        stats: { ...snap.stats, enemies: snap.stats.enemies.map((e) => ({ ...e, name: typeof e.type === "string" ? enemyName(e.type) : null })) },
        daily: snap.daily,
        standingToday,
        dailyCaps: caps,
        importStatus: getImportStatus(),
        currencies: inventory ? inventory.currencies : profileCurrencies,
        owned: Object.fromEntries(ownedCounts),
        weapons,
        pacts,
        mastery: inventory?.mastery ?? null,
        envoyRank,
        timers: inventory ? withCollector(await withAgariNames(withStarred(inventory.timers, (await getSettings()).timerWatch)), await loggedCollector()) : [],
        discoveries: inventory ? await getDiscoveries(inventory.loreScans) : null,
        temperProgress: inventory?.temperProgress ?? [],
        upgradeItems: inventory?.upgradeItems ?? null,
        crafting: inventory?.crafting ?? null,
        pickups,
        trades,
        builds,
        totems: inventory?.totems ?? null,
        inventory: inventory ? { source: inventory.source, updatedAt: inventory.updatedAt, itemCount: inventory.items.length } : null,
        capturedAt: snap.capturedAt,
        profileError,
      });
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
}

export async function recordHistory(inventory?: InventoryView | null) {
  if (inventory === undefined) inventory = await getInventory();
  if (!inventory) {
    const [history, pickups] = await Promise.all([tradeHistory(), pickupHistory()]);
    return { trades: history.length ? { history, remaining: null, max: null } : null, pickups };
  }
  const trades = await recordTrades(inventory.holdings, inventory.updatedAt);
  const pickups = await recordPickups(inventory.weaponInstances, inventory.acquisition, tradedIds(trades.history));
  return { trades, pickups };
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startServer(port = Number(process.env.SFHELPER_PORT ?? 4317)): Promise<RunningServer> {
  const hosts = new Set<string>();
  const server = createServer((req, res) => {
    handle(req, res, hosts).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, HOST, () => {
      const actual = (server.address() as { port: number }).port;
      for (const name of [HOST, "localhost"]) hosts.add(`${name}:${actual}`);
      const url = `http://${HOST}:${actual}`;
      console.log(`SFHelper dashboard: ${url}`);
      resolve({
        port: actual,
        url,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
