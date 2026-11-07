import { readFile, rm } from "node:fs/promises";
import { writeFileAtomic } from "../server/files";
import { cacheStamp, readGameFiles, type GameFiles } from "./cache";
import { clearGameData, updateGameData, type UpdateOptions, type UpdateResult } from "./update";
import type { Wiki } from "./wiki";

export const SETTLE_MS = 2 * 60_000;
export const RETRY_MS = 24 * 3600_000;

export interface GameDataState {
  app: string;
  hash: string;
  stamp: string;
  at: number;
  complete: boolean;
}

export type CheckOutcome = "no-game" | "cleared" | "settling" | "current" | "same-files" | "updated" | "failed";

export interface WatcherOptions {
  statePath: string;
  outDir: string;
  bundledDir: string;
  appVersion: string;
  locate: () => Promise<{ dir: string | null; build: string | null }>;
  wiki?: () => Wiki | null;
  log: (msg: string) => void;
  onChanged: () => void;
  readFiles?: (dir: string) => Promise<GameFiles>;
  update?: (o: UpdateOptions) => Promise<UpdateResult>;
  now?: () => number;
}

export async function readState(path: string): Promise<GameDataState | null> {
  try {
    const s = JSON.parse(await readFile(path, "utf8")) as Partial<GameDataState>;
    return typeof s.app === "string" && typeof s.hash === "string" && typeof s.stamp === "string" && typeof s.at === "number"
      ? { app: s.app, hash: s.hash, stamp: s.stamp, at: s.at, complete: s.complete === true }
      : null;
  } catch {
    return null;
  }
}

export class GameDataWatcher {
  private busy: Promise<CheckOutcome> | null = null;
  private lastError = "";

  constructor(private readonly o: WatcherOptions) {}

  check(): Promise<CheckOutcome> {
    this.busy ??= this.run()
      .then((outcome) => {
        this.lastError = "";
        return outcome;
      })
      .catch((err: unknown): CheckOutcome => {
        const message = (err as Error).message;
        if (message !== this.lastError) this.o.log(`Game data update failed (keeping the current data): ${message}`);
        this.lastError = message;
        return "failed";
      })
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  private async run(): Promise<CheckOutcome> {
    const o = this.o;
    const now = o.now ?? Date.now;
    const state = await readState(o.statePath);
    const appChanged = state !== null && state.app !== o.appVersion;
    const { dir, build } = await o.locate();
    if (!dir) {
      if (!appChanged) return "no-game";
      await clearGameData(o.outDir);
      await rm(o.statePath, { force: true });
      o.onChanged();
      return "cleared";
    }
    const stamp = await cacheStamp(dir);
    if (!stamp || now() - stamp.changedAt < SETTLE_MS) return "settling";
    const retry = state !== null && !state.complete && now() - state.at > RETRY_MS;
    const current = state !== null && !appChanged && !retry;
    if (current && state.stamp === stamp.id) return "current";
    const files = await (o.readFiles ?? readGameFiles)(dir);
    if (current && state.hash === files.hash) {
      await writeFileAtomic(o.statePath, JSON.stringify({ ...state, stamp: stamp.id }));
      return "same-files";
    }
    o.log(`Updating names, locations and items from Soulframe's game files${build ? ` (build ${build})` : ""}…`);
    const result = await (o.update ?? updateGameData)({
      files,
      cacheDir: dir,
      outDir: o.outDir,
      bundledDir: o.bundledDir,
      wiki: o.wiki?.() ?? null,
      log: o.log,
    });
    const next: GameDataState = { app: o.appVersion, hash: files.hash, stamp: stamp.id, at: now(), complete: !result.incomplete };
    await writeFileAtomic(o.statePath, JSON.stringify(next));
    if (result.changed.length) o.onChanged();
    o.log(result.summary);
    return "updated";
  }
}
