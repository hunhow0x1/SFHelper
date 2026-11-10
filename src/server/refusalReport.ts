import { appendFile, readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { readRequests, summarizeRequests } from "./requestLog";
import type { GameRefusals, RefusalDetail } from "./gameLog";

const BEFORE_MS = 2 * 3600_000;
const MAX_DETAILS = 8;

const reportPath = () => appFile("refusals.log");
const iso = (t: number) => new Date(t).toISOString();

export interface RefusalContext {
  refusals: GameRefusals;
  details: RefusalDetail[];
  publicAddress: string | null;
  build: string | null;
  appVersion: string;
  gameRunning: boolean;
  late: boolean;
}

async function append(record: Record<string, unknown>): Promise<void> {
  await appendFile(reportPath(), `${JSON.stringify(record)}\n`);
}

export async function reportedRefusals(): Promise<{ event: string; firstRefusal: string }[]> {
  try {
    return (await readFile(reportPath(), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { event: string; firstRefusal: string });
  } catch {
    return [];
  }
}

export async function alreadyReported(first: number): Promise<boolean> {
  const records = (await reportedRefusals()).filter((r) => r.firstRefusal === iso(first));
  return records.length > 0 && records[records.length - 1]!.event === "start";
}

export async function recordRefusalStart(c: RefusalContext, now = Date.now()): Promise<void> {
  const before = await readRequests(c.refusals.first - BEFORE_MS, c.refusals.first);
  await append({
    event: "start",
    recordedAt: iso(now),
    firstRefusal: iso(c.refusals.first),
    lastRefusal: iso(c.refusals.last),
    count: c.refusals.count,
    late: c.late,
    details: c.details.slice(0, MAX_DETAILS).map((d) => ({ at: iso(d.at), status: d.status, server: d.server, before: d.before, after: d.after })),
    game: { build: c.build, publicAddress: c.publicAddress, running: c.gameRunning },
    sfhelper: { version: c.appVersion },
    requestsBefore: summarizeRequests(before),
  });
}

export async function recordRefusalEnd(r: GameRefusals, gameRunning: boolean, now = Date.now()): Promise<void> {
  await append({
    event: "end",
    recordedAt: iso(now),
    firstRefusal: iso(r.first),
    lastRefusal: iso(r.last),
    count: r.count,
    minutes: Math.round((r.last - r.first) / 60_000),
    gameRunning,
  });
}
