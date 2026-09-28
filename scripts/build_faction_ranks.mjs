// Scrape per-faction, per-rank standing caps from wiki.avakot.org.
//
//   node scripts/build_faction_ranks.mjs [names.json] [faction-ranks.json]
//
// Each faction's wiki page has a "== Ranks ==" table with a "Favour Cap" column:
// the standing earned WITHIN that rank to advance to the next (and the holding
// cap at max rank). The dashboard turns these into cumulative thresholds so a
// faction's bar fills toward its current rank's cap.
//
// Output: { "<Tag>": [cap0, cap1, ...], "default": [...] }. Page titles come
// from names.json's factions map (tag -> in-game name = wiki page title).

import { readFile, writeFile } from "node:fs/promises";

const [namesPath = "src/server/public/names.json", outPath = "src/server/public/faction-ranks.json"] =
  process.argv.slice(2);
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const API = "https://wiki.avakot.org/w/api.php";

async function wikitext(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return "";
  const data = await res.json();
  return data?.parse?.wikitext?.["*"] ?? "";
}

// Rows look like: | 0 || Neutral || <rewards> || [[File:FactionStanding.png|...]] '''5,000'''
function extractCaps(text) {
  const caps = [];
  const re = /^\|\s*(\d)\s*\|\|.*?FactionStanding\.png[^\]]*\]\]\s*'*([\d,]+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    caps[Number(m[1])] = Number(m[2].replaceAll(",", ""));
  }
  return caps.every((c) => typeof c === "number") && caps.length ? caps : null;
}

const factions = JSON.parse(await readFile(namesPath, "utf8")).factions ?? {};
const out = {};
for (const [tag, page] of Object.entries(factions)) {
  const caps = extractCaps(await wikitext(page));
  if (caps) {
    out[tag] = caps;
    console.error(`${tag} (${page}): ${caps.join(", ")}`);
  } else {
    console.error(`${tag} (${page}): no rank table found`);
  }
}
// A fallback curve for factions whose page has no table (e.g. Ode).
out.default = out.SilentRoseSyndicate ?? [5000, 5000, 20000, 20000, 30000, 30000];

await writeFile(outPath, JSON.stringify(out, null, 2));
console.error(`Wrote ${outPath}: ${Object.keys(out).length - 1} factions + default.`);
