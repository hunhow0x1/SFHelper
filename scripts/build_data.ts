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

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

// Temper Tag (AspectFingerprint.buff) -> in-game name. Derived from the game's
// own localization strings (Aspect*Name / Skills/*Name), which are authoritative;
// only the Tag->name pairing is curated here. ChargeRateMod has no localized name.
const TEMPER_NAME: Record<string, string> = {
  AerialAttackDamageAMod: "From Above",
  AttackSpeedMod: "Swift Strike",
  BlockingLessStaggerMod: "Fortified",
  CassidDamageOnNearDeathMod: "Invader",
  CassidDamageOnUndamagedMod: "First Strike",
  CassidParryStaggerMod: "Clam's Foot",
  CassidPoisonMod: "Sickness",
  ChargeRateMod: "Quick Draw", // bow charge rate
  ConsecutiveAfterHeavyMod: "Follow Up",
  CritChanceMod: "Sullying Force", // Smite chance (Soulframe's crit mechanic)
  DamageNoSidearmMod: "Unencumbered",
  DamageWhenFullHealthMod: "Hale and Hearty",
  DeflectDamageMod: "Arcane Rebound",
  DendritFireDamageMod: "Enkindled",
  DendritHealOnKillMod: "Renewed Slayer",
  DendritRegainDecayMod: "Well Woven",
  DendritRegainMod: "Hunter's Relish",
  DodgeAttackDamageMod: "Rejoinder",
  DodgeFocusMod: "Grounding Spell",
  FeyDuplicateProjMod: "Duplicate",
  FeykinArcanicDamageMod: "Aftershock",
  FeykinDamageToNearbyMod: "Sympathy Pang",
  FocusedHeavyAttackDamageMod: "Conjuration",
  HeavyAttackDamageAndStaggerMod: "Full Force",
  HeavyAttackWindUpMod: "Breakneck",
  HeavyCastWindUpMod: "Arcane Alacrity",
  LegShotMod: "Severed Root",
  MagickHeavyAttackDamageAndStaggerMod: "Arcane Barrage",
  MendicantBleedDamageMod: "Savagery",
  MendicantFearMod: "Unnerving Blow",
  MendicantFearThrowMod: "Sinister Volley",
  MendicantWeaknessMod: "Hollowed",
  OdeReduceDefenseMod: "Bypass",
  OdeStaggerToKnockdownMod: "Slinger's Tempo",
  OdeVoltaicDamageMod: "Galvanic Strike",
  ParryWindowMod: "Heightened Parry",
  RiposteDamageMod: "Vengeance",
  ShatterDamageMod: "Rupture",
  SprintAttackDamageMod: "Bounding Swipe",
  StaggerCritMod: "Cowp",
  StaggerMod: "Swooning Blow",
  ThrowSpeedMod: "Streamlined",
};

/** Pull a temper's effect from its wiki page (Mechanics section, else Overview). */
function temperEffect(extract: string): string | null {
  let m = extract.match(/==+\s*Mechanics\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i);
  let t = m ? m[1]! : "";
  if (!t) {
    // Fall back to the Overview, dropping the "<Name> is a ... Temper ..." lead-in.
    const ov = extract.match(/==+\s*Overview\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i);
    t = ov ? ov[1]!.replace(/^[\s\S]*?Temper[^.]*\.\s*/i, "") : "";
  }
  t = t
    .replace(/\s+/g, " ")
    .replace(/\s+%/g, "%")
    // Drop the wiki's unknown-value placeholders ("unknown amount", "???") so
    // they don't surface in the app.
    .replace(/\s+by an unknown amount/gi, "")
    .replace(/\s+by an unspecified amount/gi, "")
    .replace(/,?\s*and\s+\?\?\?[^.,]*/gi, "")
    .replace(/\s*\?\?\?[^.,]*/g, "")
    // Drop editorial parentheticals the wiki sometimes leaves in.
    .replace(/\s*\([^)]*\b(?:need|needs|seem|confirm|approx|unconfirm|citation|TODO|unknown|assum)\w*[^)]*\)/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Keep it concise: first 1-2 sentences.
  // A "." only ends a sentence when followed by whitespace/end, so decimals
  // like "~12.5%" aren't split mid-number.
  const sentences = t.match(/(?:[^.]|\.(?!\s|$))*\.(?=\s|$)/g);
  if (sentences) t = sentences.slice(0, 2).map((x) => x.trim()).join(" ").trim();
  return t && t.length > 6 ? t : null;
}

/** Build tempers.json { "<Tag>": { name, effect } } from the curated Tag->name
 *  map plus each temper's wiki effect. */
export async function buildTempers(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const tags = Object.keys(TEMPER_NAME).sort();
  const out: Record<string, { name: string; effect: string | null }> = {};
  let ok = 0;
  const unparsed: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    const name = TEMPER_NAME[tag]!;
    onProgress?.(i, tags.length, name);
    try {
      const r = await j(`${API}?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(name)}`);
      const pages = r.query?.pages ?? {};
      const extract = pages[Object.keys(pages)[0] ?? ""]?.extract ?? "";
      out[tag] = { name, effect: temperEffect(extract) };
      if (out[tag].effect) ok++; else unparsed.push(name);
    } catch {
      out[tag] = { name, effect: null };
      unparsed.push(name);
    }
  }
  onProgress?.(tags.length, tags.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived: 0, unparsed };
}

// Pact Arts: skill ItemType (path after "/Pacts/") -> in-game name, tree slot and
// max rank. Names come from the game's localization; max rank = the node's pip
// count + 1 (virtues 3, passives & Rooted 4, the single-pip general arts 2).
// Slots are the node positions of the current (Preludes 13+) tree layout. Every
// Pact shares the general arts; the two passives are Pact-specific ("A" is the
// root node the tree branches from). Legacy arts (Akin/Healer, Voided, Sympathy,
// whose ItemTypes linger in old allocations) are intentionally absent.
type ArtSlot =
  | "passiveA" | "passiveB" | "virtueTop" | "virtueMid" | "virtueRight"
  | "rooted" | "physic" | "forestall" | "wingspan" | "stalwart";
interface ArtDef { name: string; slot: ArtSlot; max: number; virtue?: string }
const PACT_ARTS: Record<string, ArtDef> = {
  // General arts (shared by every Pact)
  "Fey/CourageVirtueUpgradeSkill": { name: "Mora's Pride", slot: "virtueTop", max: 3, virtue: "Courage" },
  "Fey/GraceVirtueUpgradeSkill": { name: "Saphene's Gift", slot: "virtueMid", max: 3, virtue: "Grace" },
  "Fey/SpiritVirtueUpgradeSkill": { name: "Iridis' Favour", slot: "virtueRight", max: 3, virtue: "Spirit" },
  "Fey/StabilityUpgradeSkill": { name: "Rooted", slot: "rooted", max: 4 },
  "Fey/BirdTimeUpgradeSkill": { name: "Wingspan", slot: "wingspan", max: 2 },
  "Fencer/HealthPotionMaxStackUpgradeSkill": { name: "Physic", slot: "physic", max: 2 },
  "Fey/PreventDeathUpgradeSkill": { name: "Forestall", slot: "forestall", max: 2 },
  "Fey/PreventStabilityBreakUpgradeSkill": { name: "Stalwart", slot: "stalwart", max: 2 },
  // Pact passives
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

/** Strip wikitext markup to plain text. */
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

/** Tidy a prose snippet: drop wiki placeholders/editorial notes, keep <=2 sentences. */
function tidy(t: string): string | null {
  t = t
    .replace(/\s+/g, " ")
    .replace(/\s+%/g, "%")
    .replace(/\s*\([^)]*\b(?:need|needs|seem|confirm|approx|unconfirm|citation|TODO|unknown|assum|may scale)\w*[^)]*\)/gi, "")
    .replace(/\s*\?\?\?[^.,]*/g, "")
    .replace(/\*+/g, "")
    // "0 points: 0 1 point: 2 2 points: 3 ..." -> "[2 / 3 / ...]." (per rank)
    .replace(/:?\s*((?:\d+ points?: [\d.]+%?\s*){2,})/g, (_m, list: string) => {
      const vals = [...list.matchAll(/(\d+) points?: ([\d.]+%?)/g)].filter((x) => x[1] !== "0").map((x) => x[2]);
      return `: [${vals.join(" / ")}]. `;
    })
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Skip editorial sentences (wiki notes about the in-game text, TBDs, bugs).
  const sentences = t.match(/(?:[^.]|\.(?!\s|$))*\.(?=\s|$)/g)
    ?.map((x) => x.trim())
    .filter((x) => !/misleading|\bTBD\b|despite (?:its|the) description|in-game description|^It also does not|not yet (?:been )?tested|bugged/i.test(x));
  if (sentences) t = sentences.slice(0, 2).join(" ").trim();
  return t && t.length > 6 ? t : null;
}

/** Build pactarts.json { "<Folder/Skill>": { name, slot, max, virtue?, desc, detail } }.
 *  General arts & virtues: the in-game quote and first mechanics bullet from the
 *  Pact Arts page. Passives: their page's overview line and ability details. */
export async function buildPactArts(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; archived: number; unparsed: string[] }> {
  const keys = Object.keys(PACT_ARTS).sort();
  const out: Record<string, ArtDef & { desc: string | null; detail: string | null }> = {};
  const unparsed: string[] = [];
  let ok = 0;
  // General arts + virtues live on the Pact Arts page as
  //   '''Name''' - ''"quote"''  followed by "* mechanics" bullets.
  const general = new Map<string, { desc: string; detail: string | null }>();
  try {
    const r = await j(`${API}?action=parse&format=json&prop=wikitext&page=Pact_Arts`);
    const wt: string = r.parse?.wikitext?.["*"] ?? "";
    // Only the current arts (not the "Legacy Pact Arts" archive section).
    const current = wt.split(/==\s*Legacy Pact Arts\s*==/)[0] ?? wt;
    const re = /'''(.+?)'''\s*-\s*''"?(.+?)"?''(?!')[^\n]*((?:\n\s*[*•][^\n]*)*)/g;
    for (let m; (m = re.exec(current)); ) {
      const bullets = (m[3] ?? "").split(/\n\s*[*•]\s*/).map(stripWiki).filter(Boolean);
      // Prefer a bullet with a concrete number; skip "not yet tested" notes.
      const concrete = bullets.find((b) => /\d/.test(b) && !/not yet (?:been )?tested|replaced/i.test(b))
        ?? bullets.find((b) => !/not yet (?:been )?tested|replaced/i.test(b)) ?? null;
      general.set(stripWiki(m[1]!), { desc: stripWiki(m[2]!), detail: concrete ? tidy(concrete) : null });
    }
  } catch { /* fall through: general arts get no text */ }

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
      } catch { /* leave empty */ }
    }
    out[key] = { ...def, desc, detail };
    if (desc || detail) ok++; else unparsed.push(def.name);
  }
  onProgress?.(keys.length, keys.length, "done");
  await writeSorted(outPath, out);
  return { ok, archived: 0, unparsed };
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

export interface TotemData {
  animal: string;
  /** What fires the effect: "Runes (Passive)", "Rune Activation", "Pull Smite", "Smite Proc". */
  enhances: string;
  description: string;
  /** Effect template with $1, $2... placeholders. */
  effect: string;
  /** Per placeholder, the value at ranks 1-4. */
  base: string[][];
  /** Same, for grip-aligned (Combat Art) copies; null where the wiki doesn't know it. */
  grip: (string | null)[][];
}

/** "5/8/10/15,4/5/6/7" -> [["5","8","10","15"],["4","5","6","7"]]; unknowns ("-", "?", "X") -> null. */
const statGroups = (s: string): (string | null)[][] =>
  s.split(",").map((g) => g.split("/").map((v) => (/^[\d.]+$/.test(v.trim()) ? v.trim() : null)));

/** Build totemdata.json from the wiki's Module:Data/Totems (the data behind its
 *  totem cards): animal, trigger, effect template and per-rank stats, including
 *  the stronger values a grip-aligned totem gets. */
export async function buildTotemData(outPath: string, onProgress?: ProgressFn): Promise<{ ok: number; unparsed: string[] }> {
  onProgress?.(0, 1, "Module:Data/Totems");
  const r = await j(`${API}?action=parse&page=${encodeURIComponent("Module:Data/Totems")}&prop=wikitext&format=json`);
  const lua: string = r.parse?.wikitext?.["*"] ?? "";
  const out: Record<string, TotemData> = {};
  const unparsed: string[] = [];
  // Each entry: ["Name"] = { ...fields..., bonuses = { effect = "" }, stats = { base = "", gripBonusBase = "" } }
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s{4}\}/g)) {
    const name = m[1]!;
    const f: Record<string, string> = {};
    for (const kv of m[2]!.matchAll(/(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) f[kv[1]!] = kv[2]!.replace(/\\"/g, '"');
    if (!f.Animal || !f.effect || !f.base) { unparsed.push(name); continue; }
    const base = statGroups(f.base);
    if (base.some((g) => g.some((v) => v === null))) { unparsed.push(name); continue; }
    out[name] = {
      animal: f.Animal,
      enhances: f.Enhances ?? "",
      description: f.description ?? "",
      effect: f.effect,
      base: base as string[][],
      grip: f.gripBonusBase ? statGroups(f.gripBonusBase) : base,
    };
  }
  onProgress?.(1, 1, "done");
  // Never replace good data with nothing if the module's format changes.
  if (Object.keys(out).length < 10) throw new Error(`Module:Data/Totems parsed only ${Object.keys(out).length} totems`);
  await writeSorted(outPath, out);
  return { ok: Object.keys(out).length, unparsed };
}

/** File slug a temper's icon is stored under: "Heightened Parry" -> "heightened-parry". */
export const temperIconSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Download every temper's in-game icon (the wiki hosts the game's art, listed
 *  in Module:Data/Tempers) into outDir as <slug>.png, resized to 96px with
 *  ImageMagick when available. Dev-time only: the icons are bundled with the
 *  app rather than fetched at launch. */
export async function buildTemperIcons(outDir: string, onProgress?: ProgressFn): Promise<{ ok: number; unparsed: string[] }> {
  const r = await j(`${API}?action=parse&page=${encodeURIComponent("Module:Data/Tempers")}&prop=wikitext&format=json`);
  const lua: string = r.parse?.wikitext?.["*"] ?? "";
  const icons = new Map<string, string>(); // temper name -> wiki file name
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n {2}\},/g)) {
    const icon = /Icon\s*=\s*"([^"]+)"/.exec(m[2]!)?.[1];
    if (icon) icons.set(m[1]!, icon);
  }
  if (icons.size < 10) throw new Error(`Module:Data/Tempers listed only ${icons.size} icons`);
  // Resolve file names to URLs, 50 per request.
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
    } else if (kind === "tempers") {
      const out = process.argv[3] ?? "src/server/public/tempers.json";
      const r = await buildTempers(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} temper effects (${r.unparsed.length} without effect).\n`);
    } else if (kind === "tempericons") {
      const out = process.argv[3] ?? "src/server/public/img/tempers";
      const r = await buildTemperIcons(out, bar);
      process.stderr.write(`\nWrote ${r.ok} temper icons to ${out} (${r.unparsed.length} missing: ${r.unparsed.join(", ")}).\n`);
    } else if (kind === "totemdata") {
      const out = process.argv[3] ?? "src/server/public/totemdata.json";
      const r = await buildTotemData(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} totems (${r.unparsed.length} unparsed: ${r.unparsed.join(", ")}).\n`);
    } else if (kind === "pactarts") {
      const out = process.argv[3] ?? "src/server/public/pactarts.json";
      const r = await buildPactArts(out, bar);
      process.stderr.write(`\nWrote ${out}: ${r.ok} pact arts with text (${r.unparsed.length} without: ${r.unparsed.join(", ")}).\n`);
    } else {
      process.stderr.write("usage: tsx scripts/build_data.ts <totems|totemdata|tempericons|runes|weapons|pacts|tempers|pactarts> [outPath]\n");
      process.exit(2);
    }
  };
  run().catch((e) => { console.error(e); process.exit(1); });
}
