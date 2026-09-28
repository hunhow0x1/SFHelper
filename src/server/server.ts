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

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
const MIN_FETCH_INTERVAL_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
 *  does not hammer DE's server. Throws EndpointRefused text on 403/429. */
async function getProfile(accountId: string): Promise<ProfileSnapshot> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at < MIN_FETCH_INTERVAL_MS) return cached.snapshot;

  const response = await fetch(PROFILE_ENDPOINT + encodeURIComponent(accountId), {
    headers: { "user-agent": USER_AGENT },
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(`Soulframe refused the request (${response.status}). Backing off.`);
  }
  if (!response.ok) throw new Error(`Profile lookup failed (${response.status}).`);

  const text = await response.text();
  if (text.trim() === "") throw new Error("No profile for that account id.");
  const snapshot = snapshotFromProfile(JSON.parse(text) as unknown, new Date().toISOString());
  cache.set(accountId, { at: Date.now(), snapshot });
  return snapshot;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(full);
    const ext = full.slice(full.lastIndexOf("."));
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
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
      sendJson(res, 200, {
        account: snap.account,
        level: PlayerLevel ?? null,
        items: snap.items.map((it) =>
          ownedCounts.has(it.key) ? { ...it, count: ownedCounts.get(it.key) } : it,
        ),
        progression: snap.progression,
        stats: snap.stats,
        daily: snap.daily,
        currencies: inventory ? inventory.currencies : profileCurrencies,
        owned: Object.fromEntries(ownedCounts), // ItemType -> owned count (for tokens, etc.)
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

const port = Number(process.env.SFHELPER_PORT ?? 4317);
createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  });
}).listen(port, () => {
  console.log(`SFHelper dashboard: http://localhost:${port}`);
});
