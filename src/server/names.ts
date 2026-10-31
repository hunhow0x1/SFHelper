import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appFile } from "./paths";

export interface NameDict {
  items: Record<string, string>;
  factions: Record<string, string>;
  factionTokens: Record<string, string>;
  currencies: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SEED = join(HERE, "public", "names.json");
const configPath = () => appFile("config.json");
const cachePath = () => appFile("names.cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

let memo: { at: number; dict: NameDict } | null = null;

function emptyDict(): NameDict {
  return { items: {}, factions: {}, factionTokens: {}, currencies: {} };
}

function coerce(raw: unknown): NameDict {
  const dict = emptyDict();
  if (!raw || typeof raw !== "object") return dict;
  for (const group of ["items", "factions", "factionTokens", "currencies"] as const) {
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
    factionTokens: { ...base.factionTokens, ...over.factionTokens },
    currencies: { ...base.currencies, ...over.currencies },
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
  const config = (await readJson(configPath())) as { namesUrl?: unknown } | null;
  return typeof config?.namesUrl === "string" && config.namesUrl ? config.namesUrl : null;
}

async function fetchRemote(url: string): Promise<NameDict | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    const dict = coerce(await res.json());
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify({ at: Date.now(), dict }, null, 2));
    return dict;
  } catch {
    return null;
  }
}

async function readCache(): Promise<{ at: number; dict: NameDict } | null> {
  const raw = (await readJson(cachePath())) as { at?: number; dict?: unknown } | null;
  if (!raw || typeof raw.at !== "number") return null;
  return { at: raw.at, dict: coerce(raw.dict) };
}

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
