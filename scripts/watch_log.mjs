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

const RE = /weapon|pick.?up|loot|acquir|granted|reward|inventory|temper|moonsteel|OnItem|added|drop|Foundry|craft|dismantl/i;
const SKIP = /Could not find object|Spot-loading|Cached header|Used shared/i;

let pos = statSync(path).size;
let carry = "";

function drain() {
  let size;
  try { size = statSync(path).size; } catch { return; }
  if (size < pos) pos = 0;
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
setInterval(drain, 1000);
