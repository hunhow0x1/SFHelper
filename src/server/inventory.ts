/** Read a local inventory.json and expose its currencies and owned items.
 *
 *  The public profile carries no currencies or owned-item counts. Those come
 *  from an inventory.php dump - written by the memory helper, or from a DE data
 *  request. This module looks for such a file on disk and parses it with the
 *  same json-import logic the app uses for any DE inventory export, so the
 *  dashboard can show currencies and counts once one exists. No file, no data -
 *  the dashboard just shows its "import your inventory" note.
 *
 *  Search order: SFHELPER_INVENTORY, ./inventory.json (where the helper writes
 *  by default), then ~/.config/sfhelper/inventory.json.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { snapshotFromExport } from "../account/providers/jsonImport";
import { parseBuilds, type Build } from "./loadouts";

const CANDIDATES = [
  process.env.SFHELPER_INVENTORY,
  process.env.SFHELPER_HOME ? join(process.env.SFHELPER_HOME, "inventory.json") : undefined,
  join(process.cwd(), "inventory.json"),
  join(homedir(), ".config", "sfhelper", "inventory.json"),
].filter((p): p is string => Boolean(p));

export interface OwnedItem {
  key: string;
  displayName: string | null;
  count: number;
}

export interface InventoryView {
  currencies: Record<string, number>;
  items: OwnedItem[];
  builds: Build[];
  source: string;
  /** File mtime, so the dashboard can say how fresh the inventory is. */
  updatedAt: string;
}

let memo: { at: number; path: string; mtimeMs: number; view: InventoryView } | null = null;

/** The parsed inventory, or null if no file is present. Re-reads when the file
 *  changes (the helper rewrites it) but memoizes within a short window. */
export async function getInventory(): Promise<InventoryView | null> {
  for (const path of CANDIDATES) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue; // not present; try the next candidate
    }
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs && Date.now() - memo.at < 10_000) {
      return memo.view;
    }
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const snap = snapshotFromExport(raw, new Date().toISOString());
      const view: InventoryView = {
        currencies: snap.currencies,
        items: snap.items.map((i) => ({ key: i.key, displayName: i.displayName, count: i.count })),
        builds: parseBuilds(raw),
        source: path,
        updatedAt: new Date(mtimeMs).toISOString(),
      };
      memo = { at: Date.now(), path, mtimeMs, view };
      return view;
    } catch {
      // Malformed file - skip rather than break the dashboard.
      continue;
    }
  }
  return null;
}
