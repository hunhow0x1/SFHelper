import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { snapshotFromExport } from "../account/providers/jsonImport";
import { parseBuilds, type Build } from "./loadouts";
import { parseTotems, type OwnedTotem } from "./totems";
import { parseWeapons, parsePacts, parseMastery, parseTemperProgress, parseWeaponInstances, parseAcquisitionContext, type AcquisitionContext, type OwnedWeapon, type OwnedPact, type TemperProgress, type WeaponInstance } from "./weapons";
import { parseHoldings, type Holdings } from "./trades";
import { parseTimers, type GameTimer } from "./timers";
import { parseLoreScans, type LoreScan } from "./discoveries";
import { parseUpgradeItems, type UpgradeItems } from "./upgradeItems";
import { parseCrafting, type CraftingState } from "./recipes";
import { appFile } from "./paths";

const candidates = (): string[] =>
  [process.env.SFHELPER_INVENTORY, appFile("inventory.json"), join(process.cwd(), "inventory.json")].filter(
    (p): p is string => Boolean(p),
  );

export interface OwnedItem {
  key: string;
  displayName: string | null;
  count: number;
}

export interface InventoryView {
  currencies: Record<string, number>;
  items: OwnedItem[];
  builds: Build[];
  weapons: OwnedWeapon[];
  pacts: OwnedPact[];
  mastery: Record<string, number>;
  temperProgress: TemperProgress[];
  totems: OwnedTotem[];
  upgradeItems: UpgradeItems;
  crafting: CraftingState;
  daily: { affiliation: number | null; affiliationOde: number | null };
  weaponInstances: WeaponInstance[];
  acquisition: AcquisitionContext;
  holdings: Holdings;
  timers: GameTimer[];
  loreScans: Record<string, LoreScan>;
  source: string;
  updatedAt: string;
}

let memo: { at: number; path: string; mtimeMs: number; view: InventoryView } | null = null;

export async function getInventory(): Promise<InventoryView | null> {
  for (const path of candidates()) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
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
        weapons: parseWeapons(raw),
        pacts: parsePacts(raw),
        mastery: parseMastery(raw),
        temperProgress: parseTemperProgress(raw),
        totems: parseTotems(raw),
        upgradeItems: parseUpgradeItems(raw),
        crafting: parseCrafting(raw),
        daily: {
          affiliation: typeof raw.DailyAffiliation === "number" ? raw.DailyAffiliation : null,
          affiliationOde: typeof raw.DailyAffiliationOde === "number" ? raw.DailyAffiliationOde : null,
        },
        weaponInstances: parseWeaponInstances(raw),
        acquisition: parseAcquisitionContext(raw),
        holdings: parseHoldings(raw),
        timers: parseTimers(raw),
        loreScans: parseLoreScans(raw),
        source: path,
        updatedAt: new Date(mtimeMs).toISOString(),
      };
      memo = { at: Date.now(), path, mtimeMs, view };
      return view;
    } catch {
      continue;
    }
  }
  return null;
}
