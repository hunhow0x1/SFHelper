import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;
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
    }
  }
  return null;
}

export async function discoverAccountId(): Promise<DiscoveredAccount | null> {
  const saved = await fromConfig();
  if (saved) return { accountId: saved, source: "config" };
  const lg = await fromLittleGenius();
  if (lg) return { accountId: lg, source: "little-genius" };
  return null;
}

export async function rememberAccountId(accountId: string): Promise<void> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account id must be 24 hex characters");
  const path = configPath();
  await writeFileAtomic(path, `${JSON.stringify({ accountId }, null, 2)}\n`);
}
