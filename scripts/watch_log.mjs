// Diagnostic: tail Soulframe's EE.log and print lines that look like item/weapon
// events, so we can learn the exact format the game logs a weapon PICKUP in
// (and whether it logs Moonsteel / tempers). Run this, then pick up a weapon
// in-game (ideally a Moonsteel one) and share the lines it prints.
//
//   npm run watch-log            # auto-find EE.log
//   SFHELPER_EELOG=/path/EE.log npm run watch-log
//
// This is READ-ONLY: it only reads the log file.

import { watch, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function autoFind() {
  if (process.env.SFHELPER_EELOG) return process.env.SFHELPER_EELOG;
  const direct = join(homedir(), ".local/share/Steam/steamapps/compatdata");
  try {
    for (const id of readdirSync(direct)) {
      const p = join(direct, id, "pfx/drive_c/users/steamuser/AppData/Local/Soulframe/EE.log");
      if (existsSync(p)) return p;
    }
  } catch {}
  // Native Windows location
  if (process.env.LOCALAPPDATA) {
    const p = join(process.env.LOCALAPPDATA, "Soulframe", "EE.log");
    if (existsSync(p)) return p;
  }
  return null;
}

const path = autoFind();
if (!path) {
  console.error("Could not find EE.log. Set SFHELPER_EELOG=/path/to/EE.log");
  process.exit(1);
}
console.error(`Watching ${path}\nPick up a weapon in-game; matching lines print below.\n`);

// Lines worth surfacing while hunting for the pickup format.
const RE = /weapon|pick.?up|loot|acquir|granted|reward|inventory|temper|moonsteel|OnItem|added|drop|Foundry|craft|dismantl/i;
// Skip the constant "Could not find object" Warframe load errors.
const SKIP = /Could not find object|Spot-loading|Cached header|Used shared/i;

let pos = statSync(path).size; // start at end; only show NEW lines
let carry = "";

function drain() {
  let size;
  try { size = statSync(path).size; } catch { return; }
  if (size < pos) pos = 0; // file rotated/truncated
  if (size === pos) return;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - pos);
  readSync(fd, buf, 0, buf.length, pos);
  closeSync(fd);
  pos = size;
  carry += buf.toString("latin1");
  const lines = carry.split(/\r?\n/);
  carry = lines.pop() ?? "";
  for (const line of lines) {
    if (RE.test(line) && !SKIP.test(line)) console.log(line);
  }
}

watch(path, { persistent: true }, drain);
setInterval(drain, 1000); // fallback poll (some FS don't fire watch events)
