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
  grip?: string | null;
}

interface Arsenal {
  weapons?: Record<string, GameWeapon>;
  pacts?: Record<string, string>;
}

const OTHER = "Other";
const byName = <T>(entries: [string, T][]): Record<string, T> => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

// Weapons are classed by their grip, as the game names it (Long Blade, Heavy…).
export function buildRoster(arsenal: Arsenal | null): Roster {
  const weapons = byName(Object.values(arsenal?.weapons ?? {}).map((w): [string, RosterWeapon] => [w.name, { class: w.grip || OTHER, slot: w.slot }]));
  const pacts = byName(Object.values(arsenal?.pacts ?? {}).map((n): [string, Record<string, never>] => [n, {}]));
  return { weapons, pacts };
}

export async function getRoster(): Promise<Roster> {
  return buildRoster(await readDataJson<Arsenal>("arsenal.json"));
}
