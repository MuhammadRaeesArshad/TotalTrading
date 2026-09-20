/**
 * Folds the runs a sweep produced into one row, so a sweep of thirty runs
 * takes one line in the list instead of thirty.
 *
 * Pure and dependency-free: `checks/group.check.ts` runs it under plain Node.
 * Erasable TypeScript only.
 */
import type { Run, Sweep } from './types';

export type Row =
  | { kind: 'run'; run: Run }
  | { kind: 'sweep'; sweep: Sweep; runs: Run[] };

/**
 * `runs` in the order they are to be shown; a sweep sits where its first run
 * does, so a sort still decides where the group lands.
 *
 * A run can answer cells of several sweeps — the fingerprint shares identical
 * questions — so it goes to the first sweep that claims it. Pass sweeps newest
 * first and it stays with the most recent one. A sweep with fewer than two runs
 * on screen is not worth a fold and its runs stay plain rows.
 */
export function groupBySweep(runs: Run[], sweeps: Sweep[]): Row[] {
  const owner = new Map<string, Sweep>();
  for (const s of sweeps) {
    for (const c of s.cells) if (c.runId && !owner.has(c.runId)) owner.set(c.runId, s);
  }

  const members = new Map<string, Run[]>();
  for (const r of runs) {
    const s = owner.get(r._id);
    if (s) members.set(s._id, [...(members.get(s._id) ?? []), r]);
  }

  const rows: Row[] = [];
  const placed = new Set<string>();
  for (const r of runs) {
    const s = owner.get(r._id);
    const group = s && members.get(s._id);
    if (!s || !group || group.length < 2) {
      rows.push({ kind: 'run', run: r });
    } else if (!placed.has(s._id)) {
      placed.add(s._id);
      rows.push({ kind: 'sweep', sweep: s, runs: group });
    }
  }
  return rows;
}

/** The run with the highest net profit — what a collapsed sweep shows. */
export function bestRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.metrics && (!best?.metrics || r.metrics.netProfit > best.metrics.netProfit)) best = r;
  }
  return best;
}
