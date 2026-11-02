const SLOT_WORD: Record<string, string> = { Helmets: "helm", Body: "body", Legs: "legs" };
const VARIANT_WORDS = new Set(["closed", "open"]);

const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w === "helmet" ? "helm" : w))
    .filter((w) => w && !VARIANT_WORDS.has(w));

function core(name: string, slot: string): string | null {
  const ws = words(name);
  const i = ws.lastIndexOf(slot);
  if (i < 0) return null;
  ws.splice(i, 1);
  return ws.join("");
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function matchArmourStem(leaf: string, folder: string, stems: string[]): string | null {
  const slot = SLOT_WORD[folder];
  const want = slot ? core(leaf, slot) : null;
  if (!slot || !want) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  let tied = false;
  for (const stem of stems) {
    const have = core(stem, slot);
    if (have === null) continue;
    const contains = Math.min(have.length, want.length) >= 5 && (have.includes(want) || want.includes(have));
    const score = have === want ? 0 : contains ? 1 : 1 + editDistance(have, want);
    if (score < bestScore) [best, bestScore, tied] = [stem, score, false];
    else if (score === bestScore) tied = true;
  }
  const limit = want.length >= 8 ? 3 : 2;
  return best !== null && !tied && bestScore <= limit ? best : null;
}
