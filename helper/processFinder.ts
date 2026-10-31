import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FULL_NAME = "Soulframe.x64.exe";
const COMM_TRUNCATED = FULL_NAME.slice(0, 15);

export interface FoundProcess {
  pid: number;
  matchedOn: "cmdline" | "comm" | "tasklist";
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
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

async function findLinux(): Promise<FoundProcess[]> {
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

async function findWindows(): Promise<FoundProcess[]> {
  const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const found: FoundProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
    if (cols.length < 2) continue;
    if (cols[0]?.toLowerCase() === FULL_NAME.toLowerCase()) {
      const pid = Number(cols[1]);
      if (Number.isFinite(pid)) found.push({ pid, matchedOn: "tasklist" });
    }
  }
  return found;
}

export async function findSoulframe(): Promise<FoundProcess[]> {
  return process.platform === "win32" ? findWindows() : findLinux();
}
