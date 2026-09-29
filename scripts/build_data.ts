/** Build the wiki-sourced effect data files: totems.json and runes.json.
 *
 *  Exposed as functions so both the CLI (`tsx scripts/build_data.ts totems|runes`)
 *  and the Electron app (on launch) can run them. The app writes to its writable
 *  data dir; the CLI writes into src/server/public for development.
 *
 *  Totem effects come from each totem page's "Base Effect" line (or a prose
 *  fallback); rune effects from the page's "Overview" via the TextExtracts API.
 *  Archived/removed entries are skipped.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

export type ProgressFn = (done: number, total: number, label: string) => void;

const j = async (url: string): Promise<any> =>
  (await fetch(url, { headers: { "user-agent": UA } })).json();

/** Write an object as JSON with keys sorted (stable diffs), values intact. */
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

const cleanHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\[edit[^\]]*\]|edit source|edit/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+%/g, "%")
    .replace(/\+\s+/g, "+")
    .trim();

const isArchived = (t: string): boolean => /article is archived|now-removed|obsolete version/i.test(t);

async function pageHtml(name: string): Promise<string> {
  const r = await j(`${API}?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json`);
  return r.parse?.text?.["*"] ?? "";
}
async function pageExtract(name: string): Promise<string> {
  const r = await j(`${API}?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(name)}`);
  const pages = r.query?.pages ?? {};
  return pages[Object.keys(pages)[0] ?? ""]?.extract ?? "";
}

function totemEffect(txt: string, name: string): string | null {
  let m = txt.match(/Base Effect\s+(.*?)\s+(?:Grip Bonus|Bonus Effect|Trivia|Acquisition|Update History|Stats|Index of|$)/i);
  if (m && m[1] && m[1].length > 3) return m[1].trim().replace(/\s*\.$/, "");
  m = txt.match(new RegExp(`Whilst[^.]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^.]*\\.`, "i")) || txt.match(/Whilst[^.]*\./);
  if (m) return m[0].trim();
  const overview = txt.replace(/^.*?Overview\s*/i, "");
  m = overview.match(/[^.]*\b(?:increase[sd]?|grant[s]?|deal[s]?|heal[s]?|restore[s]?|reduce[s]?|gain[s]?|creat[es]+|appl[iesy]+|add[s]?|boost[s]?|\+\d)[^.]*\./i);
  if (m && m[0].trim().length > 8) return m[0].trim();
  return null;
}

function runeEffect(extract: string): string | null {
  const m = extract.match(/==+\s*Overview\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i);
  const t = (m ? m[1]! : extract).replace(/\s+/g, " ").replace(/\s+%/g, "%").replace(/\+\s+/g, "+").trim();
  return t && t.length > 6 ? t : null;
}

export async function buildTotems(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const names = await categoryMembers("Totems");
  const out: Record<string, string> = {};
  let ok = 0, archived = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    onProgress?.(i, names.length, names[i]!);
    try {
      const txt = cleanHtml(await pageHtml(names[i]!));
      if (isArchived(txt)) { archived++; continue; }
      const eff = totemEffect(txt, names[i]!);
      if (eff) { out[names[i]!] = eff; ok++; } else unparsed.push(names[i]!);
    } catch { unparsed.push(names[i]!); }
  }
  onProgress?.(names.length, names.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived, unparsed };
}

// The actual weapon-type categories (a page also carries virtue/faction/damage
// categories, so we match this whitelist rather than "first non-meta category").
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

export interface WeaponInfo { class: string; slot: string; }

/** Build weapons.json { "<Weapon Name>": { class, slot } } from the wiki, so the
 *  app can show the full roster (including weapons the player doesn't own). */
export async function buildWeapons(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const names = await categoryMembers("Weapons");
  const out: Record<string, WeaponInfo> = {};
  let ok = 0, archived = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    onProgress?.(i, names.length, names[i]!);
    try {
      const cats = await pageCategories(names[i]!);
      // Skip removed (Archived) and not-yet-released (Upcoming/Unreleased) items.
      if (cats.some((c) => /^Archived|^Upcoming$|^Unreleased$/i.test(c))) { archived++; continue; }
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

/** Build pacts.json { "<Pact Name>": {} } — the full roster of Pacts (souls).
 *  Category:Pacts mixes real Pacts with Pact abilities/arts; a real Pact page
 *  carries the "Items" category and lacks "Abilities". */
export async function buildPacts(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const names = await categoryMembers("Pacts");
  const out: Record<string, Record<string, never>> = {};
  let ok = 0, archived = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    onProgress?.(i, names.length, names[i]!);
    try {
      const cats = await pageCategories(names[i]!);
      // A real, released Pact has "Items", isn't an "Abilities" page, and isn't "Upcoming".
      if (cats.includes("Abilities") || !cats.includes("Items")) continue;
      if (cats.includes("Upcoming") || cats.includes("Unreleased")) { archived++; continue; }
      out[names[i]!] = {};
      ok++;
    } catch { unparsed.push(names[i]!); }
  }
  onProgress?.(names.length, names.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived, unparsed };
}

export async function buildRunes(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const names = await categoryMembers("Runes");
  const out: Record<string, string> = {};
  let ok = 0, archived = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    onProgress?.(i, names.length, names[i]!);
    try {
      const text = await pageExtract(names[i]!);
      if (isArchived(text)) { archived++; continue; }
      const eff = runeEffect(text);
      if (eff) { out[names[i]!] = eff; ok++; } else unparsed.push(names[i]!);
    } catch { unparsed.push(names[i]!); }
  }
  onProgress?.(names.length, names.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived, unparsed };
}

// CLI: tsx scripts/build_data.ts <totems|runes> [outPath]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = process.argv[2];
  const barW = 28;
  const bar: ProgressFn = (done, total, label) => {
    const f = Math.round((done / total) * barW);
    const pct = String(Math.round((done / total) * 100)).padStart(3);
    process.stderr.write(`\r[${"█".repeat(f)}${"░".repeat(barW - f)}] ${pct}% ${done}/${total}  ${label}`.slice(0, 100).padEnd(102));
  };
  const run = async () => {
    if (kind === "totems") {
      const out = process.argv[3] ?? "src/server/public/totems.json";
      const r = await buildTotems(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} totem effects (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "runes") {
      const out = process.argv[3] ?? "src/server/public/runes.json";
      const r = await buildRunes(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} rune effects (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "weapons") {
      const out = process.argv[3] ?? "src/server/public/weapons.json";
      const r = await buildWeapons(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} weapons (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "pacts") {
      const out = process.argv[3] ?? "src/server/public/pacts.json";
      const r = await buildPacts(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} pacts (${r.unparsed.length} unparsed).\n`);
    } else {
      process.stderr.write("usage: tsx scripts/build_data.ts <totems|runes|weapons|pacts> [outPath]\n");
      process.exit(2);
    }
  };
  run().catch((e) => { console.error(e); process.exit(1); });
}
