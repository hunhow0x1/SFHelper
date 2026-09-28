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

  if (url.pathname === "/api/profile") {
    const accountId = url.searchParams.get("accountId") ?? "";
    if (!ACCOUNT_ID_RE.test(accountId)) {
      sendJson(res, 400, { error: "Enter your 24-character account id." });
      return;
    }
    try {
      const snap = await getProfile(accountId);
      sendJson(res, 200, {
        account: snap.account,
        level: snap.currencies.PlayerLevel ?? null,
        items: snap.items,
        progression: snap.progression,
        stats: snap.stats,
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
