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
out.default = out.SilentRoseSyndicate ?? [5000, 5000, 20000, 20000, 30000, 30000];

await writeFile(outPath, JSON.stringify(out, null, 2));
console.error(`Wrote ${outPath}: ${Object.keys(out).length - 1} factions + default.`);
