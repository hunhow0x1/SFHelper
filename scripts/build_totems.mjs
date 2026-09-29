// Build totems.json { "<Totem Name>": "<effect text>" } from the wiki.
//
// The account data and game localization carry totem NAMES but not their
// mechanical effects (localization descriptions are flavor text, and the
// zstd-block-compressed ones aren't decodable with Node's stdlib). Each totem's
// wiki page states its effect, so we scrape those once into a data file the
// dashboard serves - same pattern as build_faction_ranks.mjs.
//
// Archived/removed totems (the old attunement "mote" sets) are skipped: they're
// no longer in the game, so their absence is expected, not an error.
//
// Usage: node scripts/build_totems.mjs [out=src/server/public/totems.json]

import { writeFile } from "node:fs/promises";

const OUT = process.argv[2] ?? "src/server/public/totems.json";
const API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

const j = async (url) => (await fetch(url, { headers: { "user-agent": UA } })).json();

async function totemList() {
  const names = [];
  let cont = "";
  do {
    const r = await j(`${API}?action=query&list=categorymembers&cmtitle=Category:Totems&cmlimit=500&format=json${cont}`);
    for (const m of r.query?.categorymembers ?? []) if (m.ns === 0) names.push(m.title);
    cont = r.continue ? `&cmcontinue=${encodeURIComponent(r.continue.cmcontinue)}` : "";
  } while (cont);
  return names.sort();
}

const clean = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\[edit[^\]]*\]|edit source|edit/g, " ")
    .replace(/\s+/g, " ").replace(/\s+%/g, "%").replace(/\+\s+/g, "+").trim();

const isArchived = (txt) => /article is archived|now-removed|obsolete version/i.test(txt);

// Pull a concise effect from a current totem page.
function extractEffect(txt, name) {
  // 1) Preferred: the "Base Effect <X>" stat line.
  let m = txt.match(/Base Effect\s+(.*?)\s+(?:Grip Bonus|Bonus Effect|Trivia|Acquisition|Update History|Stats|Index of|$)/i);
  if (m && m[1] && m[1].length > 3) return m[1].trim().replace(/\s*\.$/, "");
  // 2) The "Whilst <...> <effect>." sentence.
  m = txt.match(new RegExp(`Whilst[^.]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^.]*\\.`, "i")) || txt.match(/Whilst[^.]*\./);
  if (m) return m[0].trim();
  // 3) Prose effect: first sentence in the Overview describing what it does.
  const overview = txt.replace(/^.*?Overview\s*/i, "");
  m = overview.match(/[^.]*\b(?:increase[sd]?|grant[s]?|deal[s]?|heal[s]?|restore[s]?|reduce[s]?|gain[s]?|creat[es]+|appl[iesy]+|add[s]?|boost[s]?|\+\d)[^.]*\./i);
  if (m && m[0].trim().length > 8) return m[0].trim();
  return null;
}

const names = await totemList();
const n = names.length;
const totems = {};
let ok = 0, archived = 0;
const unparsed = [];

const barWidth = 28;
function drawBar(i, label) {
  const frac = i / n;
  const filled = Math.round(frac * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const pct = String(Math.round(frac * 100)).padStart(3);
  const line = `\r[${bar}] ${pct}% ${String(i).padStart(3)}/${n}  ${label}`.slice(0, 100);
  process.stderr.write(line.padEnd(102));
}

for (let i = 0; i < n; i++) {
  const name = names[i];
  drawBar(i, name);
  try {
    const r = await j(`${API}?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json`);
    const txt = clean(r.parse?.text?.["*"] ?? "");
    if (isArchived(txt)) { archived++; continue; }
    const eff = extractEffect(txt, name);
    if (eff) { totems[name] = eff; ok++; } else unparsed.push(name);
  } catch { unparsed.push(name); }
}
drawBar(n, "done");
process.stderr.write("\n");

await writeFile(OUT, JSON.stringify(totems, Object.keys(totems).sort(), 2));
console.error(`Wrote ${OUT}: ${ok} totem effects  (${archived} archived skipped, ${unparsed.length} current without a parseable effect).`);
if (unparsed.length) console.error(`  unparsed: ${unparsed.join(", ")}`);
