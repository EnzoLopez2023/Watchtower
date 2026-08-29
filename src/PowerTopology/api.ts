// Typed fetch helpers for the Power Topology API (routes/power-topology.js).

import { apiFetch } from '../services/apiClient';
import type {
  Diagram,
  DiagramGraph,
  ItemKind,
  LiveUps,
  LiveUpsEnvelope,
  PowerConnection,
  PowerItem,
  Zone,
} from './types';

export interface CreateItemPayload {
  diagram_id: number;
  name: string;
  kind: ItemKind;
  subtype?: string | null;
  plug_count?: number;
  plug_labels?: (string | null)[];
  plug_types?: (string | null)[] | null;
  watts?: number | null;
  link_live?: boolean;
  ups_id?: string | null;
  pos_x?: number;
  pos_y?: number;
  notes?: string | null;
}

export interface UpdateItemPayload {
  name?: string;
  subtype?: string | null;
  plug_count?: number;
  plug_labels?: (string | null)[];
  plug_types?: (string | null)[] | null;
  watts?: number | null;
  link_live?: boolean;
  ups_id?: string | null;
  pos_x?: number;
  pos_y?: number;
  notes?: string | null;
}

export interface CreateConnectionPayload {
  diagram_id: number;
  source_item_id: number;
  source_plug_index: number;
  target_item_id: number;
  label?: string | null;
  color?: string | null;
}

export type ReconnectConnectionPayload = Omit<CreateConnectionPayload, 'diagram_id'>;

export interface ConnectionMetaPayload {
  label?: string | null;
  color?: string | null;
}

export interface ZonePayload {
  name?: string;
  pos_x?: number;
  pos_y?: number;
  width?: number;
  height?: number;
  color?: string | null;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, {
    ...init,
    headers: init?.body
      ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
      : init?.headers,
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* no JSON body */
  }
  if (!r.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body).error)
        : `Request failed (HTTP ${r.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const powerApi = {
  listDiagrams: () =>
    req<{ diagrams: Diagram[] }>('/api/power/diagrams').then((d) => d.diagrams),

  createDiagram: (name: string) =>
    req<{ diagram: Diagram }>('/api/power/diagrams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((d) => d.diagram),

  duplicateDiagram: (id: number, name?: string) =>
    req<{ diagram: Diagram }>(`/api/power/diagrams/${id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((d) => d.diagram),

  renameDiagram: (id: number, name: string) =>
    req<{ diagram: Diagram }>(`/api/power/diagrams/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }).then((d) => d.diagram),

  deleteDiagram: (id: number) =>
    req<{ ok: boolean }>(`/api/power/diagrams/${id}`, { method: 'DELETE' }),

  getGraph: (id: number) => req<DiagramGraph>(`/api/power/diagrams/${id}`),

  createItem: (payload: CreateItemPayload) =>
    req<{ item: PowerItem }>('/api/power/items', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((d) => d.item),

  updateItem: (id: number, payload: UpdateItemPayload) =>
    req<{ item: PowerItem }>(`/api/power/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }).then((d) => d.item),

  deleteItem: (id: number) =>
    req<{ ok: boolean }>(`/api/power/items/${id}`, { method: 'DELETE' }),

  createConnection: (payload: CreateConnectionPayload) =>
    req<{ connection: PowerConnection }>('/api/power/connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((d) => d.connection),

  reconnectConnection: (id: number, payload: ReconnectConnectionPayload) =>
    req<{ connection: PowerConnection }>(`/api/power/connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }).then((d) => d.connection),

  updateConnectionMeta: (id: number, payload: ConnectionMetaPayload) =>
    req<{ connection: PowerConnection }>(`/api/power/connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }).then((d) => d.connection),

  deleteConnection: (id: number) =>
    req<{ ok: boolean }>(`/api/power/connections/${id}`, { method: 'DELETE' }),

  bulkPositions: (positions: { id: number; pos_x: number; pos_y: number }[]) =>
    req<{ ok: boolean }>('/api/power/items/positions', {
      method: 'POST',
      body: JSON.stringify({ positions }),
    }),

  createZone: (diagram_id: number, payload: ZonePayload) =>
    req<{ zone: Zone }>('/api/power/zones', {
      method: 'POST',
      body: JSON.stringify({ diagram_id, ...payload }),
    }).then((d) => d.zone),

  updateZone: (id: number, payload: ZonePayload) =>
    req<{ zone: Zone }>(`/api/power/zones/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }).then((d) => d.zone),

  deleteZone: (id: number) =>
    req<{ ok: boolean }>(`/api/power/zones/${id}`, { method: 'DELETE' }),

  replaceGraph: (
    id: number,
    graph: { items: PowerItem[]; connections: PowerConnection[]; zones: Zone[] },
  ) =>
    req<{ items: PowerItem[]; connections: PowerConnection[]; zones: Zone[] }>(
      `/api/power/diagrams/${id}/graph`,
      { method: 'PUT', body: JSON.stringify(graph) },
    ),

  // Returns every unit keyed by ups_id. Previously this returned the single
  // top-level `reading`, which /api/ups documents as "the most recently
  // heard-from unit" — so with two UPSes every linked node showed the same
  // figures, and which unit they belonged to changed between polls.
  getLiveUps: async (): Promise<Record<string, LiveUps>> => {
    try {
      const r = await apiFetch('/api/ups');
      if (!r.ok) return {};
      const j = await r.json();
      const units: LiveUpsEnvelope[] = Array.isArray(j?.upses) ? j.upses : [];
      const out: Record<string, LiveUps> = {};
      for (const u of units) {
        if (!u?.ups_id) continue;
        out[u.ups_id] = {
          present: true,
          stale: Boolean(u.stale),
          label: u.label ?? u.ups_id,
          battery_charge: u.reading?.battery_charge ?? null,
          ups_load: u.reading?.ups_load ?? null,
          ups_status: u.reading?.ups_status ?? null,
          battery_runtime: u.reading?.battery_runtime ?? null,
        };
      }
      return out;
    } catch {
      return {};
    }
  },
};
