// Temper plans that a strike just completed. A plan is complete when every
// Temper planned for the weapon is on it (a Temper planned twice needs two).
// Only a change to the weapon's Tempers between two inventory reads counts, so a
// plan copied from a weapon's current Tempers isn't removed as soon as it's made.

import type { WeaponDetail } from "./trades";
import { getSettings, updateSettings } from "./settings";

export function planComplete(plan: readonly (string | null)[], tempers: readonly string[]): boolean {
  const wanted = plan.filter((t): t is string => !!t);
  if (!wanted.length) return false;
  const left = new Map<string, number>();
  for (const t of tempers) left.set(t, (left.get(t) ?? 0) + 1);
  return wanted.every((t) => {
    const n = left.get(t) ?? 0;
    left.set(t, n - 1);
    return n > 0;
  });
}

export function finishedPlans(
  plans: Record<string, (string | null)[]>,
  before: Record<string, WeaponDetail> | undefined,
  after: Record<string, WeaponDetail> | undefined,
): string[] {
  return Object.entries(plans)
    .filter(([id, plan]) => {
      const was = before?.[id];
      const now = after?.[id];
      return !!was && !!now && planComplete(plan, now.tempers) && !planComplete(plan, was.tempers);
    })
    .map(([id]) => id);
}

export async function removeFinishedPlans(before: Record<string, WeaponDetail> | undefined, after: Record<string, WeaponDetail> | undefined): Promise<string[]> {
  const s = await getSettings();
  if (!s.temperPlanAutoRemove) return [];
  const done = finishedPlans(s.temperPlans, before, after);
  if (!done.length) return [];
  const next = { ...s.temperPlans };
  for (const id of done) delete next[id];
  await updateSettings({ temperPlans: next });
  return done;
}
