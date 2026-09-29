// Build totems.json { "<Totem Name>": "<effect text>" } from the wiki.
//
// The account data and game localization carry totem NAMES but not their
// mechanical effects (localization descriptions are flavor text, and the
// zstd-block-compressed ones aren't decodable with Node's stdlib). Each totem's
// wiki page states its effect, so we scrape those once into a data file the
// dashboard serves - same pattern as build_faction_ranks.mjs.
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
  return names;
}

// Pull a concise effect from a totem page's rendered HTML.
function extractEffect(html, name) {
  const txt = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\[edit[^\]]*\]|edit source|edit/g, " ")
    .replace(/\s+/g, " ").replace(/\s+%/g, "%").trim();
  // Preferred: the "Base Effect <X> Grip Bonus" stat line.
  let m = txt.match(/Base Effect\s+(.*?)\s+(?:Grip Bonus|Bonus Effect|Trivia|Acquisition|Update History|Stats|$)/i);
  if (m && m[1] && m[1].length > 3) return m[1].trim().replace(/\s*\.$/, "");
  // Fallback: the "Whilst <name> is slotted ..." sentence.
  m = txt.match(new RegExp(`Whilst[^.]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^.]*\\.`, "i")) || txt.match(/Whilst[^.]*\./);
  if (m) return m[0].trim();
  return null;
}

const names = await totemList();
console.error(`Fetching ${names.length} totem pages…`);
const totems = {};
let ok = 0, miss = 0;
for (const name of names) {
  try {
    const r = await j(`${API}?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json`);
    const html = r.parse?.text?.["*"] ?? "";
    const eff = extractEffect(html, name);
    if (eff) { totems[name] = eff; ok++; } else miss++;
  } catch { miss++; }
}
await writeFile(OUT, JSON.stringify(totems, Object.keys(totems).sort(), 2));
console.error(`Wrote ${OUT}: ${ok} effects (${miss} without a parseable effect).`);
