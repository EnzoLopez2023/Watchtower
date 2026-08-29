// Derived graph analysis for the topology: per-provider load rollups and, for
// the outage view, whether each item is protected (fed through a UPS) or exposed.

import { plugTypeFor, type PowerConnection, type PowerItem } from './types';

/** Sum of downstream device watts for each provider (id → watts). */
export function computeLoads(
  items: PowerItem[],
  connections: PowerConnection[],
): Map<number, number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const childrenOf = new Map<number, number[]>();
  for (const c of connections) {
    const list = childrenOf.get(c.source_item_id) ?? [];
    list.push(c.target_item_id);
    childrenOf.set(c.source_item_id, list);
  }

  const memo = new Map<number, number>();
  const downstream = (id: number, seen: Set<number>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let sum = 0;
    for (const childId of childrenOf.get(id) ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (child.kind === 'device') sum += child.watts ?? 0;
      sum += downstream(childId, seen);
    }
    seen.delete(id);
    memo.set(id, sum);
    return sum;
  };

  const loads = new Map<number, number>();
  for (const it of items) {
    if (it.kind !== 'device') loads.set(it.id, downstream(it.id, new Set()));
  }
  return loads;
}

export type PowerState = 'protected' | 'exposed' | 'unknown';

/**
 * Outage impact per item.
 *
 * A UPS in the chain is NOT sufficient: every UPS here splits its outlets into a
 * battery-backed bank and a surge-only bank, and anything on the surge side
 * drops the instant mains fails. So this follows the specific plug each cable
 * uses, not merely "is there a UPS somewhere above me".
 */
export function computePowerStates(
  items: PowerItem[],
  connections: PowerConnection[],
): Map<number, PowerState> {
  const byId = new Map(items.map((i) => [i.id, i]));
  // Keep the whole connection, not just the parent id: the plug index is what
  // decides whether this cable is on the battery bank or the surge bank.
  const feedOf = new Map<number, PowerConnection>();
  for (const c of connections) feedOf.set(c.target_item_id, c);

  const out = new Map<number, PowerState>();
  for (const it of items) {
    let cur: number | undefined = it.id;
    const seen = new Set<number>();
    let state: PowerState | null = null;

    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const feed: PowerConnection | undefined = feedOf.get(cur);
      if (!feed) break;
      const parent = byId.get(feed.source_item_id);
      if (!parent) break;

      if (parent.kind === 'ups') {
        // Surge half bypasses the battery entirely.
        state = plugTypeFor(parent, feed.source_plug_index) === 'surge' ? 'exposed' : 'protected';
        break;
      }
      cur = feed.source_item_id;
    }

    if (state) out.set(it.id, state);
    else if (it.kind === 'device' && !feedOf.has(it.id)) out.set(it.id, 'unknown');
    else out.set(it.id, 'exposed');
  }
  return out;
}
