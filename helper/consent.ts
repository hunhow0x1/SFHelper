/** The ban-risk acknowledgement gate.
 *
 *  No scan runs until the user has recorded an explicit acknowledgement on
 *  disk. There is no default-on state and no bypass flag: the gate reads a
 *  file, and if the exact acknowledgement phrase is not present, the scan
 *  refuses. This mirrors warframe-api-helper's consent step.
 *
 *  The point is informed consent, recorded deliberately - not a click-through.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** The user must type this exactly. Kept verbose on purpose. */
export const ACK_PHRASE =
  "I understand reading the game's memory can risk my account and I accept that risk";

export const CONSENT_NOTICE = [
  "This tool reads the running Soulframe process's memory to obtain the",
  "session nonce needed to fetch your full inventory. It NEVER writes to",
  "memory. Reading memory is nonetheless the behavior Digital Extremes'",
  "clients are known to monitor for; only proceed on an account whose risk",
  "you accept and have cleared for yourself.",
  "",
  `To proceed, the consent file must contain exactly:`,
  `  ${ACK_PHRASE}`,
].join("\n");

export interface ConsentRecord {
  acknowledged: boolean;
  phrase: string;
  recordedAt: string;
}

export async function readConsent(path: string): Promise<ConsentRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ConsentRecord>;
    if (parsed.phrase === ACK_PHRASE && parsed.acknowledged === true) {
      return {
        acknowledged: true,
        phrase: parsed.phrase,
        recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Record consent. `typedPhrase` must match ACK_PHRASE exactly or this throws. */
export async function recordConsent(path: string, typedPhrase: string): Promise<ConsentRecord> {
  if (typedPhrase.trim() !== ACK_PHRASE) {
    throw new Error("Acknowledgement phrase does not match; consent not recorded.");
  }
  const record: ConsentRecord = {
    acknowledged: true,
    phrase: ACK_PHRASE,
    recordedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Throw unless valid consent is on disk. Every scan entry point calls this. */
export async function requireConsent(path: string): Promise<void> {
  const consent = await readConsent(path);
  if (!consent?.acknowledged) {
    throw new Error(
      `Ban-risk not acknowledged. Refusing to scan.\n\n${CONSENT_NOTICE}`,
    );
  }
}
