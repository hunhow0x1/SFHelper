import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PACKAGES_PATH = join(homedir(), ".cache", "sfhelper-cache", "0", "Packages.bin_H");

export function readTypeTree(buf) {
  const parentOf = new Map();
  const text = buf.toString("latin1");
  const DIR_RE = /\/(?:SF|EE|Lotus)\/[A-Za-z0-9_/]*\/\x01/g;
  for (let m; (m = DIR_RE.exec(text)); ) {
    const start = m.index;
    const dir = m[0].slice(0, -1);
    if (start < 4 || buf.readUInt32LE(start - 4) !== dir.length) continue;
    let i = start + dir.length + 1;
    const count = buf.readUInt32LE(i);
    i += 4;
    if (count > 100_000) continue;
    const found = [];
    try {
      for (let n = 0; n < count; n += 1) {
        const nl = buf.readUInt32LE(i);
        const leaf = buf.toString("latin1", i + 4, i + 4 + nl);
        i += 4 + nl + 3;
        const pl = buf.readUInt32LE(i);
        const parent = buf.toString("latin1", i + 4, i + 4 + pl);
        i += 4 + pl;
        if (!/^[\w.-]+$/.test(leaf)) throw new Error("not a record");
        found.push([dir + leaf, parent.startsWith("/") ? parent : parent ? dir + parent : null]);
      }
    } catch {
      continue;
    }
    for (const [path, parent] of found) parentOf.set(path, parent);
  }
  return parentOf;
}
