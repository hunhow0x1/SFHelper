import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

export function appHome(): string {
  return process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
}

export function appFile(name: string): string {
  return join(appHome(), name);
}

export function dataDir(): string | null {
  return process.env.SFHELPER_DATA_DIR ? normalize(process.env.SFHELPER_DATA_DIR) : null;
}

export async function readDataJson<T>(name: string): Promise<T | null> {
  for (const dir of [dataDir(), PUBLIC_DIR]) {
    if (!dir) continue;
    try {
      return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
    } catch {
    }
  }
  return null;
}
