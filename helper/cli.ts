/** SFHelper memory helper - standalone entry point.
 *
 *  Run OUTSIDE the app. Order of operations, each a hard gate:
 *    1. Require a recorded ban-risk acknowledgement, or refuse.
 *    2. Find the running Soulframe process.
 *    3. Open its memory READ-ONLY and gather candidate nonces.
 *    4. Verify candidates against the live endpoint; save the first that works.
 *
 *  Usage:
 *    node cli.js --account <24-hex-id> [--out inventory.json] [--consent path]
 *    node cli.js --ack "<phrase>"     # record consent, then exit
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { recordConsent, requireConsent, CONSENT_NOTICE } from "./consent";
import { findSoulframe } from "./processFinder";
import { ReadOnlyMemory } from "./memoryReader";
import { findNonceCandidates } from "./nonceLocator";
import { verifyNonce, saveInventory, EndpointRefusedError } from "./fetchInventory";

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
    console.error(`\nRecord consent with:\n  node cli.js --ack "<phrase above>"`);
    return 2;
  }

  if (!args.account) {
    console.error("Missing --account <24-hex-id>.");
    console.error(CONSENT_NOTICE);
    return 2;
  }

  const procs = await findSoulframe();
  if (procs.length === 0) {
    console.error("Soulframe is not running, or its process is not visible.");
    return 3;
  }

  // The game must be logged in for the nonce to exist and the session to be live.
  let candidates: string[] = [];
  let usablePid: number | null = null;
  for (const proc of procs) {
    try {
      const mem = await ReadOnlyMemory.open(proc.pid);
      try {
        candidates = await findNonceCandidates(mem, args.account);
      } finally {
        await mem.close();
      }
      usablePid = proc.pid;
      if (candidates.length > 0) break;
    } catch {
      // Not readable (uid mismatch / ptrace_scope). Try the next pid.
    }
  }

  if (usablePid === null) {
    console.error(
      "Could not read the game's memory. On most distros you must run this as\n" +
        "the same user that owns the game, and /proc/sys/kernel/yama/ptrace_scope\n" +
        "may need to be 0 for this session.",
    );
    return 4;
  }
  if (candidates.length === 0) {
    console.error("No nonce candidates found. Make sure you are logged in to a character.");
    return 5;
  }

  console.log(`Found ${candidates.length} candidate(s); verifying against the live endpoint...`);
  try {
    const result = await verifyNonce(args.account, candidates);
    if (!result) {
      console.error("No candidate was accepted. The session may not be live, or the");
      console.error("anchors in nonceLocator.ts need widening for this game build.");
      return 6;
    }
    await saveInventory(args.out, result.body);
    console.log(`Inventory saved to ${args.out}. Import it in the app via 'Import a file'.`);
    return 0;
  } catch (err) {
    if (err instanceof EndpointRefusedError) {
      console.error(err.message);
      return 7;
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
