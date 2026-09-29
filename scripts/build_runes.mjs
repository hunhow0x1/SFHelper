// Build runes.json { "<Rune Name>": "<effect text>" } from the wiki.
//
// Like build_totems.mjs, but for Runes. Rune pages describe their effect in an
// "Overview" section (prose) rather than a "Base Effect" stat line, so we pull
// that via the TextExtracts API (clean plain text, no TOC/tables). Archived /
// removed runes are skipped.
//
// Usage: node scripts/build_runes.mjs [out=src/server/public/runes.json]

import { writeFile } from "node:fs/promises";

const OUT = process.argv[2] ?? "src/server/public/runes.json";
const API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const j = async (url) => (await fetch(url, { headers: { "user-agent": UA } })).json();

async function runeList() {
  const names = [];
  let cont = "";
  do {
    const r = await j(`${API}?action=query&list=categorymembers&cmtitle=Category:Runes&cmlimit=500&format=json${cont}`);
    for (const m of r.query?.categorymembers ?? []) if (m.ns === 0) names.push(m.title);
    cont = r.continue ? `&cmcontinue=${encodeURIComponent(r.continue.cmcontinue)}` : "";
  } while (cont);
  return names.sort();
}

async function extract(name) {
  const r = await j(`${API}?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(name)}`);
  const pages = r.query?.pages ?? {};
  return pages[Object.keys(pages)[0]]?.extract ?? "";
}

const isArchived = (t) => /article is archived|now-removed|obsolete version/i.test(t);

// The Overview section is the concise "what it does" description.
function effectFrom(text) {
  const m = text.match(/==+\s*Overview\s*==+\s*([\s\S]*?)(?=\n\s*==|$)/i);
  let t = (m ? m[1] : text).replace(/\s+/g, " ").replace(/\s+%/g, "%").replace(/\+\s+/g, "+").trim();
  // Drop a leading "<Name> is a Rune for <class> that " lead-in when present,
  // keeping it a description of the effect; otherwise keep the whole overview.
  return t || null;
}

const names = await runeList();
const n = names.length;
const runes = {};
let ok = 0, archived = 0;
const unparsed = [];
const barWidth = 28;
function drawBar(i, label) {
  const filled = Math.round((i / n) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const pct = String(Math.round((i / n) * 100)).padStart(3);
  process.stderr.write(`\r[${bar}] ${pct}% ${String(i).padStart(3)}/${n}  ${label}`.slice(0, 100).padEnd(102));
}

for (let i = 0; i < n; i++) {
  const name = names[i];
  drawBar(i, name);
  try {
    const text = await extract(name);
    if (isArchived(text)) { archived++; continue; }
    const eff = effectFrom(text);
    if (eff && eff.length > 6) { runes[name] = eff; ok++; } else unparsed.push(name);
  } catch { unparsed.push(name); }
}
drawBar(n, "done");
process.stderr.write("\n");

await writeFile(OUT, JSON.stringify(runes, Object.keys(runes).sort(), 2));
console.error(`Wrote ${OUT}: ${ok} rune effects  (${archived} archived skipped, ${unparsed.length} without a parseable effect).`);
if (unparsed.length) console.error(`  unparsed: ${unparsed.join(", ")}`);
