/** Per-user data paths, resolved on every call - never captured at import.
 *
 *  The desktop app points SFHELPER_HOME (and friends) at Electron's userData
 *  folder at startup, but the bundle has already loaded every module by then,
 *  so a module-level constant would capture the fallback instead. On Linux the
 *  fallback happens to BE the userData folder (~/.config/sfhelper), which hid
 *  this; on Windows it isn't (%APPDATA%\sfhelper), so the server looked for the
 *  account id and inventory.json in the wrong place.
 */

import { homedir } from "node:os";
import { join, normalize } from "node:path";

/** The app's per-user data folder. */
export function appHome(): string {
  return process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
}

/** A file in the app's per-user data folder. */
export function appFile(name: string): string {
  return join(appHome(), name);
}

/** Writable overlay for launch-built data (totems.json, runes.json...), if set. */
export function dataDir(): string | null {
  return process.env.SFHELPER_DATA_DIR ? normalize(process.env.SFHELPER_DATA_DIR) : null;
}
