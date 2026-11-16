import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

export type ProgressFn = (done: number, total: number, label: string) => void;

const j = async (url: string): Promise<any> =>
  (await fetch(url, { headers: { "user-agent": UA } })).json();

async function writeSorted(path: string, obj: Record<string, unknown>): Promise<void> {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  await writeFile(path, JSON.stringify(sorted, null, 2));
}

async function categoryMembers(category: string): Promise<string[]> {
  const names: string[] = [];
  let cont = "";
  do {
    const r = await j(
      `${API}?action=query&list=categorymembers&cmtitle=Category:${encodeURIComponent(category)}&cmlimit=500&format=json${cont}`,
    );
    for (const m of r.query?.categorymembers ?? []) if (m.ns === 0) names.push(m.title);
    cont = r.continue ? `&cmcontinue=${encodeURIComponent(r.continue.cmcontinue)}` : "";
  } while (cont);
  return names.sort();
}

const WEAPON_TYPES = new Set([
  "Bows", "Long Blades", "Short Blades", "Daggers", "Greatswords", "Great Swords", "Cleavers",
  "Polearms", "Spears", "Flyblades", "Magick Weapons", "Casters", "Staves", "Heavy Maces", "Maces",
  "Hammers", "Shields", "Whips", "Scythes", "Throwing Weapons", "Fists", "Claws", "Sword and Shields",
]);
const SLOT_CATEGORY: Record<string, string> = {
  "Primary Weapons": "Primary",
  Sidearm: "Sidearm",
  Sidearms: "Sidearm",
  "Secondary Weapons": "Sidearm",
};

async function pageCategories(name: string): Promise<string[]> {
  const r = await j(`${API}?action=query&format=json&prop=categories&cllimit=50&titles=${encodeURIComponent(name)}`);
  const pages = r.query?.pages ?? {};
  const cats = pages[Object.keys(pages)[0] ?? ""]?.categories ?? [];
  return cats.map((c: { title: string }) => c.title.replace(/^Category:/, ""));
}

export const patchNumber = (patch: string | null | undefined): number | null => {
  const m = /^P(\d+)$/i.exec(patch ?? "");
  return m ? Number(m[1]) : null;
};

let livePatch: Promise<number | null> | null = null;
function currentPatch(): Promise<number | null> {
  return (livePatch ??= j(`${API}?action=parse&page=${encodeURIComponent("Envoy Rank")}&prop=wikitext&format=json`)
    .then((r) => patchNumber(parseMaxMastery(r.parse?.wikitext?.["*"] ?? "")?.patch))
    .catch(() => null));
}

export function notInGame(categories: string[], live: number | null): boolean {
  if (categories.some((c) => /^(Archived|Upcoming|Unreleased|Unobtainable)/i.test(c))) return true;
  const patches = categories.map((c) => /^Preludes[ _](\d+)$/i.exec(c)?.[1]).filter((n): n is string => !!n).map(Number);
  return live !== null && patches.length > 0 && Math.min(...patches) > live;
}

export interface WeaponInfo { class: string; slot: string; }

export async function buildWeapons(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const [names, live] = await Promise.all([categoryMembers("Weapons"), currentPatch()]);
  const out: Record<string, WeaponInfo> = {};
  let ok = 0, archived = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    onProgress?.(i, names.length, names[i]!);
    try {
      const cats = await pageCategories(names[i]!);
      if (notInGame(cats, live)) { archived++; continue; }
      let slot = "";
      let klass = "";
      for (const c of cats) {
        if (SLOT_CATEGORY[c] && !slot) slot = SLOT_CATEGORY[c];
        if (WEAPON_TYPES.has(c) && !klass) klass = c;
      }
      out[names[i]!] = { class: klass || "Other", slot: slot || "" };
      ok++;
    } catch { unparsed.push(names[i]!); }
  }
  onProgress?.(names.length, names.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived, unparsed };
}

export interface MasteryRankData {
  maxMastery: number;
  patch: string;
}
export function parseMaxMastery(wikitext: string): MasteryRankData | null {
  const m = wikitext.match(/Maximum Mastery'*\s+as of\s+\{\{VerShort\|([^}|]+)\}\}\s+is\s+~?'*([\d.]+)/i);
  const max = m ? Number(m[2]) : NaN;
  return m && Number.isFinite(max) && max > 0 ? { maxMastery: max, patch: m[1]!.trim() } : null;
}

export const temperIconSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function buildTemperIcons(outDir: string, onProgress?: ProgressFn): Promise<{ ok: number; unparsed: string[] }> {
  const r = await j(`${API}?action=parse&page=${encodeURIComponent("Module:Data/Tempers")}&prop=wikitext&format=json`);
  const lua: string = r.parse?.wikitext?.["*"] ?? "";
  const icons = new Map<string, string>();
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n {2}\},/g)) {
    const icon = /Icon\s*=\s*"([^"]+)"/.exec(m[2]!)?.[1];
    if (icon) icons.set(m[1]!, icon);
  }
  if (icons.size < 10) throw new Error(`Module:Data/Tempers listed only ${icons.size} icons`);
  const url = new Map<string, string>();
  const files = [...new Set(icons.values())];
  for (let i = 0; i < files.length; i += 50) {
    const titles = files.slice(i, i + 50).map((f) => `File:${f}`).join("|");
    const q = await j(`${API}?action=query&prop=imageinfo&iiprop=url&format=json&titles=${encodeURIComponent(titles)}`);
    for (const p of Object.values(q.query?.pages ?? {}) as { title: string; imageinfo?: { url: string }[] }[]) {
      if (p.imageinfo?.[0]) url.set(p.title.replace(/^File:/, "").replace(/ /g, "_"), p.imageinfo[0].url);
    }
  }
  await mkdir(outDir, { recursive: true });
  const hasMagick = spawnSync("magick", ["-version"]).status === 0;
  let ok = 0, n = 0;
  const unparsed: string[] = [];
  for (const [name, file] of icons) {
    onProgress?.(n++, icons.size, name);
    const src = url.get(file.replace(/ /g, "_"));
    if (!src) { unparsed.push(name); continue; }
    try {
      const png = Buffer.from(await (await fetch(src, { headers: { "user-agent": UA } })).arrayBuffer());
      const out = `${outDir}/${temperIconSlug(name)}.png`;
      if (hasMagick) {
        const res = spawnSync("magick", ["png:-", "-resize", "96x96", "-strip", out], { input: png });
        if (res.status !== 0) throw new Error("magick failed");
      } else {
        await writeFile(out, png);
      }
      ok++;
    } catch { unparsed.push(name); }
  }
  onProgress?.(icons.size, icons.size, "done");
  return { ok, unparsed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = process.argv[2];
  const barW = 28;
  const bar: ProgressFn = (done, total, label) => {
    const f = Math.round((done / total) * barW);
    const pct = String(Math.round((done / total) * 100)).padStart(3);
    process.stderr.write(`\r[${"█".repeat(f)}${"░".repeat(barW - f)}] ${pct}% ${done}/${total}  ${label}`.slice(0, 100).padEnd(102));
  };
  const run = async () => {
    if (kind === "weapons") {
      const out = process.argv[3] ?? "src/server/public/weapons.json";
      const r = await buildWeapons(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} weapons (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "tempericons") {
      const out = process.argv[3] ?? "src/server/public/img/tempers";
      const r = await buildTemperIcons(out, bar);
      process.stderr.write(`\nWrote ${r.ok} temper icons to ${out} (${r.unparsed.length} missing: ${r.unparsed.join(", ")}).\n`);
    } else {
      process.stderr.write("usage: tsx scripts/build_data.ts <tempericons|weapons> [outPath]\n");
      process.exit(2);
    }
  };
  run().catch((e) => { console.error(e); process.exit(1); });
}
