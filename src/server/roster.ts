import { readDataJson } from "./paths";

export interface RosterWeapon {
  class: string;
  slot: string;
}

export interface Roster {
  weapons: Record<string, RosterWeapon>;
  pacts: Record<string, Record<string, never>>;
}

interface GameWeapon {
  name: string;
  slot: string;
  style: string | null;
  damage: string | null;
}

interface Arsenal {
  weapons?: Record<string, GameWeapon>;
  pacts?: Record<string, string>;
}

const OTHER = "Other";
const byName = <T>(entries: [string, T][]): Record<string, T> => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

function classGuesser(game: GameWeapon[], wiki: Record<string, RosterWeapon>): (w: GameWeapon) => string {
  const keys = (w: GameWeapon) => [`${w.slot}|${w.style}|${w.damage}`, `${w.slot}|${w.style}`, `${w.style}`];
  const votes = new Map<string, Map<string, number>>();
  for (const w of game) {
    const known = wiki[w.name]?.class;
    if (!known || known === OTHER) continue;
    for (const k of keys(w)) {
      const tally = votes.get(k) ?? votes.set(k, new Map()).get(k)!;
      tally.set(known, (tally.get(known) ?? 0) + 1);
    }
  }
  return (w) => {
    for (const k of keys(w)) {
      const tally = votes.get(k);
      if (tally) return [...tally].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]![0];
    }
    return OTHER;
  };
}

export function buildRoster(
  wikiWeapons: Record<string, RosterWeapon> | null,
  wikiPacts: Record<string, Record<string, never>> | null,
  arsenal: Arsenal | null,
): Roster {
  const wiki = wikiWeapons ?? {};
  const game = Object.values(arsenal?.weapons ?? {});
  const gamePacts = Object.values(arsenal?.pacts ?? {});
  const guess = classGuesser(game, wiki);
  const weapons = game.length
    ? byName(game.map((w): [string, RosterWeapon] => {
        const known = wiki[w.name]?.class;
        return [w.name, { class: known && known !== OTHER ? known : guess(w), slot: w.slot }];
      }))
    : wiki;
  const pacts = gamePacts.length ? byName(gamePacts.map((n): [string, Record<string, never>] => [n, {}])) : (wikiPacts ?? {});
  return { weapons, pacts };
}

export async function getRoster(): Promise<Roster> {
  const [weapons, pacts, arsenal] = await Promise.all([
    readDataJson<Record<string, RosterWeapon>>("weapons.json"),
    readDataJson<Record<string, Record<string, never>>>("pacts.json"),
    readDataJson<Arsenal>("arsenal.json"),
  ]);
  return buildRoster(weapons, pacts, arsenal);
}
