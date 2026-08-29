// Shared types + metadata for the Power Topology feature.

export type ItemKind = 'device' | 'power_strip' | 'ups' | 'outlet';

export type PlugType = 'battery' | 'surge';

/**
 * Which bank a plug belongs to.
 *
 * Derived from position rather than stored per plug: every UPS here splits its
 * outlets into a battery-backed half and a surge-only half, and asking the user
 * to tick that for each plug only creates a way to get it wrong (or to leave it
 * unset, which used to make the outage view report "unknown").
 *
 * Only a UPS has two banks. A power strip or a wall outlet passes through
 * whatever feeds it, so its plugs have no type of their own — the protection
 * they offer is decided further up the chain.
 */
export function plugTypeFor(item: Pick<PowerItem, 'kind' | 'plug_count'>, index: number): PlugType | null {
  if (item.kind !== 'ups') return null;
  const half = Math.ceil((item.plug_count || 0) / 2);
  return index < half ? 'battery' : 'surge';
}

export interface PowerItem {
  id: number;
  diagram_id: number;
  name: string;
  kind: ItemKind;
  /** Cosmetic device category (icon + label) — null for a generic device. */
  subtype: string | null;
  plug_count: number;
  plug_labels: (string | null)[];
  /** Legacy: protection is now derived by plugTypeFor(), not stored. */
  plug_types?: (PlugType | null)[] | null;
  /** Draw (consumer) or capacity (provider), in watts. null = unset. */
  watts: number | null;
  /** UPS only: mirror the live Power Monitor feed onto this node (0/1). */
  link_live: number;
  /** UPS only: which real unit to mirror (ups_readings.ups_id). */
  ups_id: string | null;
  pos_x: number;
  pos_y: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PowerConnection {
  id: number;
  diagram_id: number;
  source_item_id: number;
  source_plug_index: number;
  target_item_id: number;
  /** Optional cable label, e.g. "6 ft C13". */
  label: string | null;
  /** Optional circuit/breaker color (hex). */
  color: string | null;
  created_at: string;
}

export interface Zone {
  id: number;
  diagram_id: number;
  name: string;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface Diagram {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DiagramGraph {
  ok: boolean;
  diagram: Diagram;
  items: PowerItem[];
  connections: PowerConnection[];
  zones: Zone[];
}

/** Live UPS snapshot from the Power Monitor feed (/api/ups). */
export interface LiveUps {
  present: boolean;
  stale: boolean;
  /** The unit's own name, so a node can never misattribute its figures. */
  label: string;
  battery_charge: number | null;
  ups_load: number | null;
  ups_status: string | null;
  battery_runtime: number | null;
}

/** One entry of /api/ups `upses[]`. */
export interface LiveUpsEnvelope {
  ups_id: string;
  label: string | null;
  stale: boolean;
  reading: {
    battery_charge: number | null;
    ups_load: number | null;
    ups_status: string | null;
    battery_runtime: number | null;
  } | null;
}

export interface KindMeta {
  label: string;
  /** Exposes output plugs (a source of power). */
  providesPlugs: boolean;
  /** Has a power-in cord (can be plugged into something). */
  acceptsPower: boolean;
  /** Sensible starting plug count when this kind is created. */
  defaultPlugs: number;
  /** One-line hint shown in the create form. */
  hint: string;
}

export const KIND_META: Record<ItemKind, KindMeta> = {
  device: {
    label: 'Device',
    providesPlugs: false,
    acceptsPower: true,
    defaultPlugs: 0,
    hint: 'A consumer — NAS, server, drive, monitor. Has a single power-in.',
  },
  power_strip: {
    label: 'Power Strip',
    providesPlugs: true,
    acceptsPower: true,
    defaultPlugs: 6,
    hint: 'Draws power in and provides several outlets.',
  },
  ups: {
    label: 'UPS',
    providesPlugs: true,
    acceptsPower: true,
    defaultPlugs: 8,
    hint: 'Battery backup — draws power in and provides several plugs.',
  },
  outlet: {
    label: 'Wall Outlet',
    providesPlugs: true,
    acceptsPower: false,
    defaultPlugs: 2,
    hint: 'A power source (e.g. top / bottom receptacle). Cannot be powered.',
  },
};

export const KIND_ORDER: ItemKind[] = ['device', 'power_strip', 'ups', 'outlet'];

/** Display label for a plug: custom label if set, else "Plug N". */
export function plugLabel(item: PowerItem, index: number): string {
  const custom = item.plug_labels?.[index];
  return custom && custom.trim() ? custom : `Plug ${index + 1}`;
}
