/** Find the running Soulframe process on Linux (including under Proton/Wine).
 *
 *  The name handling mirrors warframe-api-helper's Warframe.x64.exe ->
 *  Warframe.x64.ex fallback, and for the same reason: Linux truncates
 *  /proc/<pid>/comm to 15 characters (TASK_COMM_LEN - 1). "Soulframe.x64.exe"
 *  is 17 chars, so comm shows "Soulframe.x64.e". We match the full name in the
 *  richer /proc/<pid>/cmdline first, and fall back to the truncated comm.
 */

import { readFile, readdir } from "node:fs/promises";

const FULL_NAME = "Soulframe.x64.exe";
/** /proc/<pid>/comm is capped at 15 visible chars. */
const COMM_TRUNCATED = FULL_NAME.slice(0, 15); // "Soulframe.x64.e"

export interface FoundProcess {
  pid: number;
  matchedOn: "cmdline" | "comm";
}

async function readComm(pid: string): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readCmdline(pid: string): Promise<string | null> {
  try {
    // cmdline is NUL-separated; the exe name can appear as a Windows-style path.
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

/** Return every matching pid. More than one usually means the game plus a
 *  Wine/Proton helper thread group; the caller picks the one whose memory is
 *  readable. */
export async function findSoulframe(): Promise<FoundProcess[]> {
  const entries = await readdir("/proc");
  const found: FoundProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readCmdline(entry);
    if (cmdline && cmdline.includes(FULL_NAME)) {
      found.push({ pid: Number(entry), matchedOn: "cmdline" });
      continue;
    }
    const comm = await readComm(entry);
    if (comm === COMM_TRUNCATED || comm === FULL_NAME) {
      found.push({ pid: Number(entry), matchedOn: "comm" });
    }
  }
  return found;
}
