/** Read the game's own log file.
 *
 *  EE.log is a plain text file the game writes to disk; reading it is no
 *  different from opening it in a text editor, needs no credentials, and
 *  never touches the running process. That makes it the best passive source
 *  available - but it only ever reports what happened while we were
 *  watching, so everything it produces is fidelity "observed" and can only
 *  add to a snapshot, never contradict a full export.
 *
 *  The line grammar lives in data/ee-log-rules.json because Soulframe's log
 *  format is undocumented and shifts between Preludes builds; a wrong regex
 *  should be a data fix, not a release.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountDataProvider, Availability, CaptureContext, ProviderMeta } from "../provider";
import { emptySnapshot, type AccountSnapshot, type SourceRef } from "../snapshot";

const PROVIDER_ID = "ee-log";
/** Only the tail matters; the file can reach tens of megabytes in a session. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export type RuleConfidence = "verified" | "likely" | "unverified";

export interface LogRule {
  id: string;
  kind: "build" | "session" | "item";
  confidence: RuleConfidence;
  pattern: string;
}

export interface LogRules {
  line: string;
  rules: LogRule[];
}

export interface ParseOptions {
  /** Rules below this confidence are skipped. Defaults to "likely". */
  minConfidence?: RuleConfidence;
  observedAt?: string;
}

const CONFIDENCE_RANK: Record<RuleConfidence, number> = {
  unverified: 0,
  likely: 1,
  verified: 2,
};

/** Default install locations. The user can always point us elsewhere. */
export function defaultLogPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [join(local, "Soulframe", "EE.log")];
  }
  // Proton/Wine keeps the same layout under the Steam compatdata prefix.
  const home = homedir();
  return [
    join(home, ".steam", "steam", "steamapps", "compatdata"),
    join(home, ".local", "share", "Soulframe", "EE.log"),
  ];
}

export function parseLog(text: string, rules: LogRules, options: ParseOptions = {}): AccountSnapshot {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const floor = CONFIDENCE_RANK[options.minConfidence ?? "likely"];
  const source: SourceRef = { providerId: PROVIDER_ID, fidelity: "observed", observedAt };
  const snapshot = emptySnapshot();
  snapshot.sources = [source];

  const lineRe = new RegExp(rules.line);
  const active = rules.rules
    .filter((rule) => CONFIDENCE_RANK[rule.confidence] >= floor)
    .map((rule) => ({ rule, re: new RegExp(rule.pattern) }));

  for (const line of text.split(/\r?\n/)) {
    const parsed = lineRe.exec(line);
    const message = parsed?.groups?.message;
    if (!message) continue;

    for (const { rule, re } of active) {
      const match = re.exec(message);
      if (!match) continue;
      const groups = match.groups ?? {};

      if (rule.kind === "build" && groups.build) {
        snapshot.gameBuild = groups.build.trim();
      } else if (rule.kind === "session" && groups.displayName) {
        snapshot.account.displayName = groups.displayName.trim();
      } else if (rule.kind === "item" && groups.name) {
        const name = groups.name.trim();
        const count = Number(groups.count ?? 1);
        snapshot.items.push({
          key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          displayName: name,
          count: Number.isFinite(count) && count > 0 ? count : 1,
          source,
        });
      }
    }
  }

  return snapshot;
}

export interface EeLogProviderDeps {
  rulesPath: string;
  candidatePaths?: string[];
}

export function createEeLogProvider(deps: EeLogProviderDeps): AccountDataProvider {
  const meta: ProviderMeta = {
    id: PROVIDER_ID,
    label: "Watch the game log",
    risk: "caution",
    requiresCredentials: false,
    touchesGameProcess: false,
    description:
      "Parse Soulframe's EE.log to notice sessions and pickups as they happen. Read-only, no credentials, no contact with the game process.",
    consentPrompt:
      "SFHelper will read Soulframe's EE.log from disk. Nothing is sent anywhere and the game is not touched, but the log format is undocumented and may be read incorrectly after a Preludes update.",
  };

  async function resolveLog(ctx: CaptureContext): Promise<string | null> {
    const candidates = [ctx.paths?.eeLog, ...(deps.candidatePaths ?? defaultLogPaths())].filter(
      (p): p is string => Boolean(p),
    );
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
      } catch {
        // Not present on this machine; try the next candidate.
      }
    }
    return null;
  }

  return {
    meta,
    async isAvailable(ctx: CaptureContext): Promise<Availability> {
      const path = await resolveLog(ctx);
      return path ? { available: true } : { available: false, reason: "no EE.log found" };
    },
    async capture(ctx: CaptureContext): Promise<AccountSnapshot> {
      const path = await resolveLog(ctx);
      if (!path) throw new Error("no EE.log found");
      const rules = JSON.parse(await readFile(deps.rulesPath, "utf8")) as LogRules;
      const text = await readFile(path, "utf8");
      return parseLog(text.slice(-MAX_TAIL_BYTES), rules);
    },
  };
}
