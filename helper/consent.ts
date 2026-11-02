import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../src/server/files";

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

export async function recordConsent(path: string, typedPhrase: string): Promise<ConsentRecord> {
  if (typedPhrase.trim() !== ACK_PHRASE) {
    throw new Error("Acknowledgement phrase does not match; consent not recorded.");
  }
  const record: ConsentRecord = {
    acknowledged: true,
    phrase: ACK_PHRASE,
    recordedAt: new Date().toISOString(),
  };
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function requireConsent(path: string): Promise<void> {
  const consent = await readConsent(path);
  if (!consent?.acknowledged) {
    throw new Error(
      `Ban-risk not acknowledged. Refusing to scan.\n\n${CONSENT_NOTICE}`,
    );
  }
}
