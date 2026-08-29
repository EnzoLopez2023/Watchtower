// Auto-layout for the topology graph using dagre. Arranges power sources at the
// top flowing down to the devices they feed (provider → consumer).

import dagre from '@dagrejs/dagre';
import { KIND_META, type PowerConnection, type PowerItem } from './types';

const NODE_HEIGHT = 96;

function nodeWidth(item: PowerItem): number {
  const plugs = KIND_META[item.kind].providesPlugs ? Math.max(0, item.plug_count) : 0;
  return Math.max(190, plugs * 52);
}

/** Returns a map of item id → top-left { x, y } for a tidy top-down layout. */
export function computeLayout(
  items: PowerItem[],
  connections: PowerConnection[],
): Map<number, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const it of items) {
    g.setNode(String(it.id), { width: nodeWidth(it), height: NODE_HEIGHT });
  }
  for (const c of connections) {
    g.setEdge(String(c.source_item_id), String(c.target_item_id));
  }

  dagre.layout(g);

  const out = new Map<number, { x: number; y: number }>();
  for (const it of items) {
    const n = g.node(String(it.id));
    if (n) out.set(it.id, { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) });
  }
  return out;
}
