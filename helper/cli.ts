/** SFHelper memory helper - standalone entry point.
 *
 *  Run OUTSIDE the app. Order of operations, each a hard gate:
 *    1. Require a recorded ban-risk acknowledgement, or refuse.
 *    2. Find the running Soulframe process.
 *    3. Open its memory READ-ONLY.
 *    4. If no --account was given, recover the account id from memory and
 *       verify it against the PUBLIC profile endpoint; write it to the app's
 *       config so the dashboard resolves it automatically thereafter.
 *    5. Gather candidate nonces; verify against the live endpoint; save the
 *       first that works to inventory.json for the app to import.
 *
 *  Usage:
 *    npm run helper -- [--account <24-hex-id>] [--out inventory.json]
 *    npm run helper -- --ack "<phrase>"     # record consent, then exit
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { recordConsent, requireConsent, CONSENT_NOTICE } from "./consent";
import { findSoulframe } from "./processFinder";
import { ReadOnlyMemory } from "./memoryReader";
import { findNonceCandidates } from "./nonceLocator";
import { findAccountIdCandidates, discoverVerifiedAccountId } from "./accountIdLocator";
import { verifyNonce, saveInventory, EndpointRefusedError } from "./fetchInventory";

const CONFIG_PATH = join(homedir(), ".config", "sfhelper", "config.json");

interface Args {
  account?: string;
  out: string;
  consent: string;
  ack?: string;
}

function parseArgs(argv: string[]): Args {
  const defaults: Args = {
    out: "inventory.json",
    consent: join(homedir(), ".config", "sfhelper", "memory_scan_consent.json"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--account" && value) defaults.account = value;
    else if (flag === "--out" && value) defaults.out = value;
    else if (flag === "--consent" && value) defaults.consent = value;
    else if (flag === "--ack" && value !== undefined) defaults.ack = value;
  }
  return defaults;
}

/** Write the discovered id where src/server/accountId.ts reads it. */
async function rememberAccountId(accountId: string): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ accountId }, null, 2)}\n`);
}

/** The account id saved by a previous run (or by the dashboard), if valid. */
async function readSavedAccountId(): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as { accountId?: string };
    return cfg.accountId && /^[0-9a-f]{24}$/i.test(cfg.accountId) ? cfg.accountId : undefined;
  } catch {
    return undefined;
  }
}

/** A throttled stderr progress bar, reset at the start of each scan pass. */
function progress(label: string): (scanned: number, total: number) => void {
  let last = -10;
  let prev = 0;
  return (scanned, total) => {
    if (scanned < prev) last = -10; // a new pass started
    prev = scanned;
    const pct = total ? Math.floor((scanned / total) * 100) : 0;
    if (pct >= last + 10) {
      last = pct;
      process.stderr.write(`\r  ${label}: ${pct}%   `);
    }
    if (scanned >= total) process.stderr.write("\n");
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.ack !== undefined) {
    await recordConsent(args.consent, args.ack);
    console.log(`Consent recorded at ${args.consent}`);
    return 0;
  }

  try {
    await requireConsent(args.consent);
  } catch (err) {
    console.error((err as Error).message);
    console.error(`\nRecord consent with:\n  npm run helper -- --ack "<phrase above>"`);
    return 2;
  }

  const procs = await findSoulframe();
  if (procs.length === 0) {
    console.error("Soulframe is not running, or its process is not visible.");
    console.error(CONSENT_NOTICE);
    return 3;
  }
  console.error(`Found Soulframe (pid ${procs.map((p) => p.pid).join(", ")}).`);

  // Prefer an explicit id, then the saved config, then a memory scan.
  let account = args.account ?? (await readSavedAccountId());
  if (account) console.error(`Using account id ${account}.`);
  let nonceCandidates: string[] = [];
  let usablePid: number | null = null;

  for (const proc of procs) {
    let mem: ReadOnlyMemory;
    try {
      mem = await ReadOnlyMemory.open(proc.pid);
    } catch {
      continue; // not readable (uid mismatch / ptrace_scope); try the next
    }
    try {
      usablePid = proc.pid;
      // Recover the account id from memory if we still do not have one.
      if (!account) {
        console.error("Scanning writable memory for the account id...");
        const idCandidates = await findAccountIdCandidates(mem, progress("account id"));
        const verified = await discoverVerifiedAccountId(idCandidates);
        if (verified) {
          account = verified.accountId;
          await rememberAccountId(account);
          console.log(
            `Found account id for ${verified.displayName ?? "your account"}; saved to ${CONFIG_PATH}.`,
          );
        }
      }
      if (account) {
        console.error("Scanning writable memory for the session nonce...");
        nonceCandidates = await findNonceCandidates(mem, account, progress("nonce"));
        console.error(`Found ${nonceCandidates.length} nonce candidate(s).`);
      }
    } finally {
      await mem.close();
    }
    if (account && nonceCandidates.length > 0) break;
  }

  if (usablePid === null) {
    console.error(
      "Could not read the game's memory. On most distros you must run this as\n" +
        "the same user that owns the game, and /proc/sys/kernel/yama/ptrace_scope\n" +
        "may need to be 0 for this session.",
    );
    return 4;
  }
  if (!account) {
    console.error("Could not recover the account id from memory. Make sure you are");
    console.error("logged in to a character, or pass --account <24-hex-id>.");
    return 5;
  }
  if (nonceCandidates.length === 0) {
    console.error("No nonce candidates found. Make sure you are logged in to a character.");
    return 6;
  }

  console.log(`Verifying ${nonceCandidates.length} nonce candidate(s) against the live endpoint...`);
  try {
    const result = await verifyNonce(account, nonceCandidates);
    if (!result) {
      console.error("No candidate was accepted. The session may not be live, or the");
      console.error("anchors in nonceLocator.ts need widening for this game build.");
      return 7;
    }
    await saveInventory(args.out, result.body);
    console.log(`Inventory saved to ${args.out}. Import it in the app via 'Import a file'.`);
    return 0;
  } catch (err) {
    if (err instanceof EndpointRefusedError) {
      console.error(err.message);
      return 8;
    }
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
