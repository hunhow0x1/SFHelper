/** SFHelper memory helper - standalone CLI entry point.
 *
 *  Thin wrapper over helper/run.ts. Order of operations is enforced there:
 *  consent gate -> find process -> open read-only -> recover/verify account id ->
 *  find & verify nonce -> save inventory.json for the app to import.
 *
 *  Usage:
 *    npm run helper -- [--account <24-hex-id>] [--out inventory.json]
 *    npm run helper -- --ack "<phrase>"     # record consent, then exit
 */

import { homedir } from "node:os";
import { recordConsent, CONSENT_NOTICE } from "./consent";
import { importInventory, defaultPaths } from "./run";

interface Args {
  account?: string;
  out?: string;
  consent?: string;
  ack?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--account" && value) args.account = value;
    else if (flag === "--out" && value) args.out = value;
    else if (flag === "--consent" && value) args.consent = value;
    else if (flag === "--ack" && value !== undefined) args.ack = value;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const defaults = defaultPaths(homedir());
  const consentPath = args.consent ?? defaults.consentPath;

  if (args.ack !== undefined) {
    await recordConsent(consentPath, args.ack);
    console.log(`Consent recorded at ${consentPath}`);
    return 0;
  }

  const result = await importInventory({
    account: args.account,
    out: args.out ?? defaults.out,
    configPath: defaults.configPath,
    consentPath,
    onLog: (m) => console.error(m),
    onProgress: (label, pct) => process.stderr.write(`\r  ${label}: ${pct}%   ${pct >= 100 ? "\n" : ""}`),
  });

  if (result.ok) {
    console.log(`${result.message} Import it in the app via 'Import a file'.`);
    return 0;
  }
  console.error(result.message);
  if (result.code === 2) console.error(`\nRecord consent with:\n  npm run helper -- --ack "<phrase above>"`);
  if (result.code === 3) console.error(CONSENT_NOTICE);
  return result.code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
