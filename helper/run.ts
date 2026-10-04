/** Programmatic entry point for the memory helper.
 *
 *  Same gated pipeline as the CLI - consent -> find process -> open read-only ->
 *  recover/verify account id -> find & verify nonce -> save inventory - but as a
 *  function returning a structured result, so both cli.ts and the Electron app
 *  can drive it. Paths are injected (the app points them at its userData dir).
 */

import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { requireConsent } from "./consent";
import { findSoulframe } from "./processFinder";
import { ReadOnlyMemory } from "./memoryReader";
import { findNonceCandidates } from "./nonceLocator";
import { findAccountIdCandidates, discoverVerifiedAccountId } from "./accountIdLocator";
import { verifyNonce, saveInventory, EndpointRefusedError } from "./fetchInventory";

export interface ImportOptions {
  account?: string | undefined;
  /** Where to write inventory.json. */
  out: string;
  /** Where the account id is cached ({accountId}). */
  configPath: string;
  /** Consent record path. */
  consentPath: string;
  onLog?: ((msg: string) => void) | undefined;
  onProgress?: ((label: string, pct: number) => void) | undefined;
  /** The session from an earlier successful import. Its nonce is tried first,
   *  so repeat imports skip the memory scan while the login session lasts. */
  session?: ImportSession | undefined;
}

/** What a successful import used. The nonce is a live session credential: the
 *  caller keeps this in memory only and never writes it to disk or the log. */
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
  /** On success: pass back as `session` next time. */
  session?: ImportSession;
}

async function rememberAccountId(configPath: string, accountId: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ accountId }, null, 2)}\n`);
}

async function readSavedAccountId(configPath: string): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf8")) as { accountId?: string };
    return cfg.accountId && /^[0-9a-f]{24}$/i.test(cfg.accountId) ? cfg.accountId : undefined;
  } catch {
    return undefined;
  }
}

/** Run the full import. Never throws for expected failures - returns a code. */
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

  // Same game process, same account: try the nonce that worked last time. It
  // holds for the whole login session, so this skips re-reading gigabytes of
  // memory; only a rejection (re-login) falls through to a fresh scan.
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
    log("The session nonce was not accepted (new login?); scanning memory again.");
  }

  let nonceCandidates: string[] = [];
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
        log(`Found ${nonceCandidates.length} nonce candidate(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
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

  log(`Verifying ${nonceCandidates.length} nonce candidate(s) against the live endpoint...`);
  try {
    const result = await verifyNonce(account, nonceCandidates);
    if (!result) {
      return { ok: false, code: 7, message: "No candidate was accepted. The session may not be live." };
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

/** Default per-user paths (used by the CLI; the app overrides these). */
export function defaultPaths(homeDir: string) {
  const dir = join(homeDir, ".config", "sfhelper");
  return {
    configPath: join(dir, "config.json"),
    consentPath: join(dir, "memory_scan_consent.json"),
    out: "inventory.json",
  };
}
