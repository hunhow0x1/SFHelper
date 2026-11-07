import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function readKnown<T>(path?: string): Promise<Record<string, T> | null> {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, T>;
  } catch {
    return null;
  }
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

const UNKNOWN_VALUE = /\?\s*\/|\/\s*\?/;

export function mergeTotemTexts(fresh: Record<string, string>, known: Record<string, string> | null): Record<string, string> {
  if (!known) return fresh;
  const out: Record<string, string> = { ...known, ...fresh };
  for (const [name, text] of Object.entries(fresh)) {
    if (UNKNOWN_VALUE.test(text) && known[name] && !UNKNOWN_VALUE.test(known[name])) out[name] = known[name];
  }
  return out;
}

export async function buildTotems(outPath: string, onProgress?: ProgressFn, knownPath?: string): Promise<{ ok: number; archived: number; unparsed: string[] }> {
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
  await writeSorted(outPath, mergeTotemTexts(out, await readKnown<string>(knownPath)));
  return { ok, archived, unparsed };
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

type ArtSlot =
  | "passiveA" | "passiveB" | "virtueTop" | "virtueMid" | "virtueRight"
  | "rooted" | "physic" | "forestall" | "wingspan" | "stalwart";
interface ArtDef { name: string; slot: ArtSlot; max: number; virtue?: string }
const PACT_ARTS: Record<string, ArtDef> = {
  "Fey/CourageVirtueUpgradeSkill": { name: "Mora's Pride", slot: "virtueTop", max: 3, virtue: "Courage" },
  "Fey/GraceVirtueUpgradeSkill": { name: "Saphene's Gift", slot: "virtueMid", max: 3, virtue: "Grace" },
  "Fey/SpiritVirtueUpgradeSkill": { name: "Iridis' Favour", slot: "virtueRight", max: 3, virtue: "Spirit" },
  "Fey/StabilityUpgradeSkill": { name: "Rooted", slot: "rooted", max: 4 },
  "Fey/BirdTimeUpgradeSkill": { name: "Wingspan", slot: "wingspan", max: 2 },
  "Fencer/HealthPotionMaxStackUpgradeSkill": { name: "Physic", slot: "physic", max: 2 },
  "Fey/PreventDeathUpgradeSkill": { name: "Forestall", slot: "forestall", max: 2 },
  "Fey/PreventStabilityBreakUpgradeSkill": { name: "Stalwart", slot: "stalwart", max: 2 },
  "Bromius/ArmourShatterInstinctSkill": { name: "Barkbare", slot: "passiveA", max: 4 },
  "Bromius/ReflectArmourlInstinctSkill": { name: "Canopy's Blessing", slot: "passiveB", max: 4 },
  "Fencer/DodgeyDecoySkill": { name: "Chamariz", slot: "passiveA", max: 4 },
  "Fencer/PokeyPokeySkill": { name: "Olho por Olho", slot: "passiveB", max: 4 },
  "Garren/InstinctAUpgradeSkill": { name: "Healheart", slot: "passiveA", max: 4 },
  "Garren/InstinctBUpgradeSkill": { name: "Righteous", slot: "passiveB", max: 4 },
  "Fenn/FanTheFlamesInstinctSkill": { name: "Hungry Flame", slot: "passiveA", max: 4 },
  "Fenn/SlowBoilInstinctSkill": { name: "Smolder", slot: "passiveB", max: 4 },
  "Ode/InstinctAUpgradeSkill": { name: "Lightning Strike", slot: "passiveA", max: 4 },
  "Ode/InstinctbUpgradeSkill": { name: "Gravitate", slot: "passiveB", max: 4 },
  "Wolf/WolfPassveUpgradeSkill": { name: "Feral", slot: "passiveA", max: 4 },
  "Wolf/WolfPackPassveUpgradeSkill": { name: "Soulbound", slot: "passiveB", max: 4 },
  "Fey/WardThornsInstinctSkill": { name: "Tendril", slot: "passiveA", max: 4 },
  "Fey/StandingWaterInstinctSkill": { name: "Vernal Pool", slot: "passiveB", max: 4 },
  "Fey/FeySightInstinctSkill": { name: "Shrouded", slot: "passiveA", max: 4 },
  "Fey/FeyStealInstinctSkill": { name: "Pickpocket", slot: "passiveB", max: 4 },
  "Fey/KillersHandInstinctSkill": { name: "Conquerer", slot: "passiveA", max: 4 },
  "Fey/LastStandInstinctSkill": { name: "Last Stand", slot: "passiveB", max: 4 },
};

const stripWiki = (s: string): string =>
  s
    .replace(/\{\{[^{}|]*\|([^{}|]*)\|Display=([^{}]*)\}\}/g, "$2")
    .replace(/\{\{[^{}|]*\|([^{}|]*)(?:\|[^{}]*)?\}\}/g, "$1")
    .replace(/\{\{([^{}|]*)\}\}/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function tidy(t: string): string | null {
  t = t
    .replace(/\s+/g, " ")
    .replace(/\s+%/g, "%")
    .replace(/\s*\([^)]*\b(?:need|needs|seem|confirm|approx|unconfirm|citation|TODO|unknown|assum|may scale)\w*[^)]*\)/gi, "")
    .replace(/\s*\?\?\?[^.,]*/g, "")
    .replace(/\*+/g, "")
    .replace(/:?\s*((?:\d+ points?: [\d.]+%?\s*){2,})/g, (_m, list: string) => {
      const vals = [...list.matchAll(/(\d+) points?: ([\d.]+%?)/g)].filter((x) => x[1] !== "0").map((x) => x[2]);
      return `: [${vals.join(" / ")}]. `;
    })
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  const sentences = t.match(/(?:[^.]|\.(?!\s|$))*\.(?=\s|$)/g)
    ?.map((x) => x.trim())
    .filter((x) => !/misleading|\bTBD\b|despite (?:its|the) description|in-game description|^It also does not|not yet (?:been )?tested|bugged/i.test(x));
  if (sentences) t = sentences.slice(0, 2).join(" ").trim();
  return t && t.length > 6 ? t : null;
}

export async function buildPactArts(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const keys = Object.keys(PACT_ARTS).sort();
  const out: Record<string, ArtDef & { desc: string | null; detail: string | null }> = {};
  const unparsed: string[] = [];
  let ok = 0;
  const general = new Map<string, { desc: string; detail: string | null }>();
  try {
    const r = await j(`${API}?action=parse&format=json&prop=wikitext&page=Pact_Arts`);
    const wt: string = r.parse?.wikitext?.["*"] ?? "";
    const current = wt.split(/==\s*Legacy Pact Arts\s*==/)[0] ?? wt;
    const re = /'''(.+?)'''\s*-\s*''"?(.+?)"?''(?!')[^\n]*((?:\n\s*[*•][^\n]*)*)/g;
    for (let m; (m = re.exec(current)); ) {
      const bullets = (m[3] ?? "").split(/\n\s*[*•]\s*/).map(stripWiki).filter(Boolean);
      const concrete = bullets.find((b) => /\d/.test(b) && !/not yet (?:been )?tested|replaced/i.test(b))
        ?? bullets.find((b) => !/not yet (?:been )?tested|replaced/i.test(b)) ?? null;
      general.set(stripWiki(m[1]!), { desc: stripWiki(m[2]!), detail: concrete ? tidy(concrete) : null });
    }
  } catch {}

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const def = PACT_ARTS[key]!;
    onProgress?.(i, keys.length, def.name);
    let desc: string | null = null, detail: string | null = null;
    const g = general.get(def.name);
    if (g) {
      desc = g.desc;
      detail = g.detail;
    } else if (def.slot.startsWith("passive")) {
      try {
        const ex = await pageExtract(def.name);
        const ov = ex.match(/==+\s*Overview\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i)?.[1] ?? "";
        desc = tidy(ov.replace(/^[\s\S]*?Passive Ability[^.]*\.\s*/i, ""));
        const ad = ex.match(/==+\s*Ability Details\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i)?.[1] ?? "";
        detail = tidy(ad);
      } catch {}
    }
    out[key] = { ...def, desc, detail };
    if (desc || detail) ok++; else unparsed.push(def.name);
  }
  onProgress?.(keys.length, keys.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived: 0, unparsed };
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
export async function buildMasteryRank(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; unparsed: string[] }> {
  onProgress?.(0, 1, "Envoy Rank");
  const r = await j(`${API}?action=parse&page=${encodeURIComponent("Envoy Rank")}&prop=wikitext&format=json`);
  const data = parseMaxMastery(r.parse?.wikitext?.["*"] ?? "");
  onProgress?.(1, 1, "done");
  if (!data) throw new Error("Envoy Rank page: maximum Mastery not found");
  await writeFile(outPath, `${JSON.stringify(data, null, 2)}\n`);
  return { ok: 1, unparsed: [] };
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
    if (kind === "totems") {
      const out = process.argv[3] ?? "src/server/public/totems.json";
      const r = await buildTotems(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} totem effects (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "weapons") {
      const out = process.argv[3] ?? "src/server/public/weapons.json";
      const r = await buildWeapons(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} weapons (${r.archived} archived skipped, ${r.unparsed.length} unparsed).\n`);
    } else if (kind === "tempericons") {
      const out = process.argv[3] ?? "src/server/public/img/tempers";
      const r = await buildTemperIcons(out, bar);
      process.stderr.write(`\nWrote ${r.ok} temper icons to ${out} (${r.unparsed.length} missing: ${r.unparsed.join(", ")}).\n`);
    } else if (kind === "masteryrank") {
      const out = process.argv[3] ?? "src/server/public/masteryrank.json";
      await buildMasteryRank(out, bar);
      process.stderr.write(`\nWrote ${out}.\n`);
    } else if (kind === "pactarts") {
      const out = process.argv[3] ?? "src/server/public/pactarts.json";
      const r = await buildPactArts(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} pact arts with text (${r.unparsed.length} without: ${r.unparsed.join(", ")}).\n`);
    } else {
      process.stderr.write("usage: tsx scripts/build_data.ts <totems|tempericons|weapons|pactarts|masteryrank> [outPath]\n");
      process.exit(2);
    }
  };
  run().catch((e) => { console.error(e); process.exit(1); });
}
