/** Resolve the in-game name dictionary from a hostable endpoint.
 *
 *  The app does not bundle the full name data or scrape a third party at
 *  runtime. Instead it pulls a names JSON from an endpoint you host (set
 *  SFHELPER_NAMES_URL, or "namesUrl" in ~/.config/sfhelper/config.json),
 *  caches it locally, and falls back to the small bundled seed when the
 *  endpoint is unset or unreachable. Resolution order, highest first:
 *
 *    1. Remote endpoint (fetched, then cached with a TTL).
 *    2. Last good cache on disk (if the remote is down).
 *    3. Bundled seed at public/names.json.
 *
 *  The shape is always { items: Record<string,string>, factions: Record<...> }.
 *  A note on the source: avakot's wiki is keyed by display name and does not
 *  carry DE internal names, so whatever you host here has to come from the
 *  game's own localization (cache extraction or the memory helper), not from
 *  scraping the wiki. This module is agnostic about how the file is produced.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface NameDict {
  items: Record<string, string>;
  factions: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SEED = join(HERE, "public", "names.json");
const CONFIG_PATH = join(homedir(), ".config", "sfhelper", "config.json");
const CACHE_PATH = join(homedir(), ".config", "sfhelper", "names.cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

let memo: { at: number; dict: NameDict } | null = null;

function emptyDict(): NameDict {
  return { items: {}, factions: {} };
}

/** Accept only the expected shape; ignore stray keys and non-string values. */
function coerce(raw: unknown): NameDict {
  const dict = emptyDict();
  if (!raw || typeof raw !== "object") return dict;
  for (const group of ["items", "factions"] as const) {
    const src = (raw as Record<string, unknown>)[group];
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") dict[group][k] = v;
      }
    }
  }
  return dict;
}

function merge(base: NameDict, over: NameDict): NameDict {
  return {
    items: { ...base.items, ...over.items },
    factions: { ...base.factions, ...over.factions },
  };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function resolveNamesUrl(): Promise<string | null> {
  if (process.env.SFHELPER_NAMES_URL) return process.env.SFHELPER_NAMES_URL;
  const config = (await readJson(CONFIG_PATH)) as { namesUrl?: unknown } | null;
  return typeof config?.namesUrl === "string" && config.namesUrl ? config.namesUrl : null;
}

async function fetchRemote(url: string): Promise<NameDict | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    const dict = coerce(await res.json());
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ at: Date.now(), dict }, null, 2));
    return dict;
  } catch {
    return null;
  }
}

async function readCache(): Promise<{ at: number; dict: NameDict } | null> {
  const raw = (await readJson(CACHE_PATH)) as { at?: number; dict?: unknown } | null;
  if (!raw || typeof raw.at !== "number") return null;
  return { at: raw.at, dict: coerce(raw.dict) };
}

/** The resolved dictionary, memoized briefly so repeated page loads are cheap. */
export async function getNames(): Promise<NameDict> {
  if (memo && Date.now() - memo.at < 60_000) return memo.dict;

  const seed = coerce(await readJson(BUNDLED_SEED));
  const url = await resolveNamesUrl();
  const cache = await readCache();

  let dict = seed;
  if (url) {
    const cacheFresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
    const remote = cacheFresh ? cache.dict : (await fetchRemote(url)) ?? cache?.dict ?? null;
    if (remote) dict = merge(seed, remote);
  } else if (cache) {
    dict = merge(seed, cache.dict);
  }

  memo = { at: Date.now(), dict };
  return dict;
}
