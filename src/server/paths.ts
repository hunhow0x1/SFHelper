import { homedir } from "node:os";
import { join, normalize } from "node:path";

export function appHome(): string {
  return process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
}

export function appFile(name: string): string {
  return join(appHome(), name);
}

export function dataDir(): string | null {
  return process.env.SFHELPER_DATA_DIR ? normalize(process.env.SFHELPER_DATA_DIR) : null;
}
