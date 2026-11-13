// One inventory import: find the game process; if the same game is still running,
// reuse the last session nonce; otherwise scan the game's memory (read-only) for
// the account id and the session nonce, then download the inventory with them.
// Only the download talks to DE's servers.

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { requireConsent } from "./consent";
import { findSoulframe } from "./processFinder";
import { ReadOnlyMemory } from "./memoryReader";
import { findNonceCandidates, type NonceCandidate } from "./nonceLocator";
import { findAccountIdCandidates, discoverVerifiedAccountId } from "./accountIdLocator";
import { verifyNonce, saveInventory, EndpointRefusedError } from "./fetchInventory";
import { writeFileAtomic } from "../src/server/files";

export interface ImportOptions {
  account?: string | undefined;
  out: string;
  configPath: string;
  consentPath: string;
  onLog?: ((msg: string) => void) | undefined;
  onProgress?: ((label: string, pct: number) => void) | undefined;
  session?: ImportSession | undefined;
}

export interface ImportSession {
  pid: number;
  accountId: string;
  nonce: string;
}

export interface ImportResult {
  ok: boolean;
  code: number;
  message: string;
  accountId?: string;
  outPath?: string;
  session?: ImportSession;
}

const rejected = { pid: 0, tokens: new Set<string>() };

function rejectedFor(pid: number): Set<string> {
  if (rejected.pid !== pid) {
    rejected.pid = pid;
    rejected.tokens = new Set();
  }
  return rejected.tokens;
}

const FORM_TEXT: Record<NonceCandidate["form"], string> = {
  address: "in the game's request addresses",
  field: "as a nonce field",
  nearby: "near the account id",
};

async function rememberAccountId(configPath: string, accountId: string): Promise<void> {
  await writeFileAtomic(configPath, `${JSON.stringify({ accountId }, null, 2)}\n`);
}

async function readSavedAccountId(configPath: string): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf8")) as { accountId?: string };
    return cfg.accountId && /^[0-9a-f]{24}$/i.test(cfg.accountId) ? cfg.accountId : undefined;
  } catch {
    return undefined;
  }
}

export async function importInventory(opts: ImportOptions): Promise<ImportResult> {
  const log = (m: string) => opts.onLog?.(m);
  const progress = (label: string) => {
    let last = -10;
    let prev = 0;
    return (scanned: number, total: number) => {
      if (scanned < prev) last = -10;
      prev = scanned;
      const pct = total ? Math.floor((scanned / total) * 100) : 0;
      if (pct >= last + 10) {
        last = pct;
        opts.onProgress?.(label, pct);
      }
    };
  };

  try {
    await requireConsent(opts.consentPath);
  } catch (err) {
    return { ok: false, code: 2, message: (err as Error).message };
  }

  const procs = await findSoulframe();
  if (procs.length === 0) {
    return { ok: false, code: 3, message: "Soulframe is not running, or its process is not visible." };
  }
  log(`Found Soulframe (pid ${procs.map((p) => p.pid).join(", ")}).`);

  let account = opts.account ?? (await readSavedAccountId(opts.configPath));
  if (account) log(`Using account id ${account}.`);

  const prev = opts.session;
  if (account && prev && prev.accountId === account && procs.some((p) => p.pid === prev.pid)) {
    log("Reusing this session's nonce (no memory scan).");
    try {
      const result = await verifyNonce(account, [prev.nonce]);
      if (result) {
        await saveInventory(opts.out, result.body);
        return { ok: true, code: 0, message: `Inventory saved to ${opts.out}.`, accountId: account, outPath: opts.out, session: prev };
      }
    } catch (err) {
      if (err instanceof EndpointRefusedError) return { ok: false, code: 8, message: err.message };
      throw err;
    }
    rejectedFor(prev.pid).add(prev.nonce);
    log("The session nonce was not accepted (new login?); scanning memory again.");
  }

  let nonceCandidates: NonceCandidate[] = [];
  let usablePid: number | null = null;

  for (const proc of procs) {
    let mem: ReadOnlyMemory;
    try {
      mem = await ReadOnlyMemory.open(proc.pid);
    } catch {
      continue;
    }
    try {
      usablePid = proc.pid;
      const regions = mem.scanRegions();
      const mb = regions.reduce((n, r) => n + (r.end - r.start), 0) / (1 << 20);
      log(`Pid ${proc.pid}: ${regions.length} writable regions, ${Math.round(mb)} MB to search.`);
      if (!account) {
        log("Scanning writable memory for the account id...");
        const idCandidates = await findAccountIdCandidates(mem, progress("account id"));
        let verified: Awaited<ReturnType<typeof discoverVerifiedAccountId>>;
        try {
          verified = await discoverVerifiedAccountId(idCandidates);
        } catch (err) {
          if (err instanceof EndpointRefusedError) return { ok: false, code: 8, message: err.message };
          throw err;
        }
        if (verified) {
          account = verified.accountId;
          await rememberAccountId(opts.configPath, account);
          log(`Found account id for ${verified.displayName ?? "your account"}.`);
        }
      }
      if (account) {
        log("Scanning writable memory for the session nonce...");
        const t0 = Date.now();
        nonceCandidates = await findNonceCandidates(mem, account, progress("nonce"));
        const best = nonceCandidates[0];
        const bestText = best ? `; the likeliest was seen ${best.seen} time(s) ${FORM_TEXT[best.form]}` : "";
        log(`Found ${nonceCandidates.length} nonce candidate(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s${bestText}.`);
      }
    } finally {
      await mem.close();
    }
    if (account && nonceCandidates.length > 0) break;
  }

  if (usablePid === null) {
    return {
      ok: false,
      code: 4,
      message:
        "Could not read the game's memory. Run as the same user that owns the game " +
        "(Linux may need /proc/sys/kernel/yama/ptrace_scope = 0; Windows may need admin).",
    };
  }
  if (!account) {
    return { ok: false, code: 5, message: "Could not recover the account id. Log in to a character, or set it manually." };
  }
  if (nonceCandidates.length === 0) {
    return { ok: false, code: 6, message: "No nonce candidates found. Make sure you are logged in to a character." };
  }

  const tried = rejectedFor(usablePid);
  const fresh = nonceCandidates.filter((c) => !tried.has(c.token));
  const next = fresh[0];
  if (!next) {
    return { ok: false, code: 7, message: "No new nonce candidates since the last ones were turned down. The session may not be live." };
  }
  log(`Trying the likeliest of ${fresh.length} untried nonce candidate(s).`);
  try {
    const result = await verifyNonce(account, [next.token]);
    if (!result) {
      tried.add(next.token);
      return {
        ok: false,
        code: 7,
        message: fresh.length > 1
          ? "The likeliest nonce wasn't accepted; SFHelper tries the next one on its next import."
          : "No candidate was accepted. The session may not be live.",
      };
    }
    await saveInventory(opts.out, result.body);
    return {
      ok: true,
      code: 0,
      message: `Inventory saved to ${opts.out}.`,
      accountId: account,
      outPath: opts.out,
      session: { pid: usablePid, accountId: account, nonce: result.nonce },
    };
  } catch (err) {
    if (err instanceof EndpointRefusedError) {
      return { ok: false, code: 8, message: err.message };
    }
    throw err;
  }
}

export function defaultPaths(homeDir: string) {
  const dir = join(homeDir, ".config", "sfhelper");
  return {
    configPath: join(dir, "config.json"),
    consentPath: join(dir, "memory_scan_consent.json"),
    out: "inventory.json",
  };
}
