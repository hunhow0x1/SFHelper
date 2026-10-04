/** Discover the player's account id without touching the game.
 *
 *  The game does not write the 24-hex account id to disk - EE.cfg holds only
 *  the login email, and it is not in EE.log - so there is no game-native file
 *  to read. Sources, in priority order:
 *
 *    1. Our own saved config. The memory helper writes it after recovering the
 *       id (see helper/accountIdLocator.ts), and it is also written the first
 *       time the id is entered by hand. This is the intended path and makes
 *       every later launch automatic.
 *    2. Little Genius's metadata.json - a LEGACY fallback only, so someone
 *       migrating from LG works on day one. Not a dependency: absent LG, the
 *       helper populates (1) instead.
 *
 *  The account id is a public identifier (it resolves through the public
 *  profile endpoint and appears in other players' squad data), not a secret.
 *  We still keep it only in the user's own config dir, never in the repo.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appFile } from "./paths";

const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
// In the app's data dir (the packaged app's userData folder; see paths.ts).
const configPath = () => appFile("config.json");

export interface DiscoveredAccount {
  accountId: string;
  source: "config" | "little-genius";
}

async function fromConfig(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as { accountId?: unknown };
    return typeof parsed.accountId === "string" && ACCOUNT_ID_RE.test(parsed.accountId)
      ? parsed.accountId
      : null;
  } catch {
    return null;
  }
}

/** Little Genius keeps its data under Avakot.org/littleGenius. On Linux the app
 *  runs inside a Steam Proton prefix, so its metadata sits under compatdata; we
 *  also check a native Windows/AppData location. */
async function littleGeniusMetadataPaths(): Promise<string[]> {
  const home = homedir();
  const tail = join(
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Local",
    "Avakot.org",
    "littleGenius",
    "metadata.json",
  );
  const paths: string[] = [];

  const compatRoot = join(home, ".local", "share", "Steam", "steamapps", "compatdata");
  try {
    for (const entry of await readdir(compatRoot)) {
      paths.push(join(compatRoot, entry, tail));
    }
  } catch {
    // No Steam library here; fall through to other candidates.
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    paths.push(join(localAppData, "Avakot.org", "littleGenius", "metadata.json"));
  }
  return paths;
}

async function fromLittleGenius(): Promise<string | null> {
  for (const path of await littleGeniusMetadataPaths()) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { last_active_account?: unknown };
      const id = parsed.last_active_account;
      if (typeof id === "string" && ACCOUNT_ID_RE.test(id)) return id;
    } catch {
      // Not this prefix; try the next.
    }
  }
  return null;
}

/** Best available account id, or null if the user must enter it once. */
export async function discoverAccountId(): Promise<DiscoveredAccount | null> {
  const saved = await fromConfig();
  if (saved) return { accountId: saved, source: "config" };
  const lg = await fromLittleGenius();
  if (lg) return { accountId: lg, source: "little-genius" };
  return null;
}

/** Persist the id so future launches resolve it from config automatically. */
export async function rememberAccountId(accountId: string): Promise<void> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account id must be 24 hex characters");
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ accountId }, null, 2)}\n`);
}
