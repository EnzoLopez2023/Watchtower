// UniFi Network Topology — auto-generated, read-only graph of the live network.
//
// Reads the latest snapshot from /api/unifi and lays out the device hierarchy
// (gateway → switches → APs) using dagre, with edges from each device's uplink.
// Optionally overlays connected clients under their uplink device, and Protect
// cameras (from /api/protect) placed under whichever switch/AP they're actually
// attached to — matched by MAC against the network client list. Clicking a
// node opens its detail. Purely visual — nothing is persisted.

import { apiFetch } from './services/apiClient';
import { CARD_RADIUS, pageShellSx } from './theme/controls';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Chip, CircularProgress } from '@mui/material';
import {
  Videocam as CameraIcon,
  SettingsEthernet as WiredIcon,
  Wifi as WirelessIcon,
} from '@mui/icons-material';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  MarkerType, useNodesState, useEdgesState,
  type Node, type Edge, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import PageHero from './components/PageHero';
import Scrim from './components/Scrim';
import { useThemeMode } from './context/ThemeContext';
import { tokensFor } from './theme/tokens';
import { DetailDrawer, type UniFiDevice, type UniFiClient, type DetailTarget } from './UniFiNetwork';

// ── Minimal shapes used for graph layout (subset of the full snapshot) ───────
interface TopoDevice {
  id: string | null;
  name: string | null;
  model: string | null;
  type: string | null;
  online: boolean;
  rx_bps: number | null;
  tx_bps: number | null;
  uplink_id: string | null;
}
interface TopoClient {
  id: string | null;
  name: string | null;
  mac: string | null;
  wired: boolean;
  uplink_id: string | null;
}
// Protect cameras live on the NVR, not the network controller, so they carry no
// uplink of their own — we resolve one by MAC via the client list.
interface TopoCamera {
  id: string | null;
  name: string | null;
  mac: string | null;
  model: string | null;
  online: boolean;
}

type Tk = ReturnType<typeof tokensFor>;
type Kind = 'gateway' | 'switch' | 'ap' | 'client' | 'camera';

const NODE_W = 190;
const NODE_H = 58;

// Matches the Protect page/dashboard tile accent so cameras read the same
// everywhere in the app.
const CAM_ACCENT = '#0E8FB8';

const normMac = (m: string | null | undefined): string => (m ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

function fmtBps(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let v = bps, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

function kindOf(d: TopoDevice): Kind {
  if (/udm|dream machine|uxg|ucg|ugw|gateway/i.test(d.model ?? '')) return 'gateway';
  if (d.type === 'accessPoint' || /\bap\b|u6|u7|ac (pro|lite|mesh|lr)|nanohd|iw/i.test(`${d.model} ${d.name}`)) return 'ap';
  return 'switch';
}

function nodeStyle(kind: Kind, online: boolean, t: Tk): React.CSSProperties {
  const accent = kind === 'gateway' ? t.rust
    : kind === 'ap' ? '#2E9E5B'
    : kind === 'camera' ? CAM_ACCENT
    : kind === 'client' ? t.muted
    : t.inkSoft;
  return {
    width: NODE_W,
    padding: '8px 10px',
    borderRadius: 12,
    background: t.paper,
    border: `1.5px solid ${online ? accent : '#C4443A'}`,
    color: t.ink,
    boxShadow: 'none',
    fontFamily: 'inherit',
  };
}

function label(title: string, sub: string, t: Tk): React.ReactNode {
  return (
    <Box sx={{ textAlign: 'left', lineHeight: 1.2 }}>
      <Typography sx={{ fontSize: '0.78rem', fontWeight: 800, color: t.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </Typography>
      <Typography sx={{ fontSize: '0.66rem', color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {sub}
      </Typography>
    </Box>
  );
}

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) } };
  });
}

function buildGraph(
  devices: TopoDevice[],
  clients: TopoClient[],
  cameras: TopoCamera[],
  showWired: boolean,
  showWireless: boolean,
  showCameras: boolean,
  t: Tk,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ids = new Set(devices.map((d) => d.id).filter(Boolean) as string[]);

  for (const d of devices) {
    if (!d.id) continue;
    const kind = kindOf(d);
    const sub = `${kind}${d.rx_bps != null || d.tx_bps != null ? ` · ↓${fmtBps(d.rx_bps)}` : ''}`;
    nodes.push({
      id: d.id,
      data: { label: label(d.name ?? d.model ?? d.id, sub, t) },
      position: { x: 0, y: 0 },
      style: nodeStyle(kind, d.online, t),
    });
  }
  for (const d of devices) {
    if (d.id && d.uplink_id && ids.has(d.uplink_id)) {
      // Weight/highlight the uplink by the device's live throughput.
      const tp = (d.rx_bps ?? 0) + (d.tx_bps ?? 0);
      const w = tp > 5e7 ? 4 : tp > 5e6 ? 3 : tp > 5e5 ? 2 : 1.2;
      const active = tp > 5e5;
      const stroke = active ? t.rust : t.line;
      edges.push({
        id: `e-${d.uplink_id}-${d.id}`,
        source: d.uplink_id,
        target: d.id,
        animated: d.online && active,
        style: { stroke, strokeWidth: w },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      });
    }
  }
  // Wired and wireless are separate questions: "what is plugged into this
  // switch" and "what is on this AP" are rarely asked at the same time, and
  // showing all 75 at once is unreadable.
  if (showWired || showWireless) {
    for (const c of clients) {
      if (!c.id || !c.uplink_id || !ids.has(c.uplink_id)) continue;
      if (c.wired ? !showWired : !showWireless) continue;
      const cid = `c-${c.id}`;
      nodes.push({
        id: cid,
        data: { label: label(c.name ?? c.mac ?? c.id, c.wired ? 'wired client' : 'wireless client', t) },
        position: { x: 0, y: 0 },
        style: nodeStyle('client', true, t),
      });
      edges.push({
        id: `ec-${c.id}`,
        source: c.uplink_id,
        target: cid,
        style: { stroke: t.line, strokeWidth: 1, strokeDasharray: '4 3' },
      });
    }
  }
  if (showCameras) {
    // Resolve each camera's parent switch/AP through its network client entry.
    // Cameras the controller hasn't seen fall back to the gateway so they're
    // still visible rather than silently dropped.
    const byMac = new Map<string, TopoClient>();
    for (const c of clients) {
      const m = normMac(c.mac);
      if (m && c.uplink_id && ids.has(c.uplink_id)) byMac.set(m, c);
    }
    const gateway = devices.find((d) => d.id && kindOf(d) === 'gateway');
    for (const cam of cameras) {
      if (!cam.id) continue;
      const match = byMac.get(normMac(cam.mac));
      const parent = match?.uplink_id ?? gateway?.id ?? null;
      if (!parent) continue;
      const camId = `cam-${cam.id}`;
      const sub = `camera${cam.model ? ` · ${cam.model}` : ''}${cam.online ? '' : ' · offline'}`;
      nodes.push({
        id: camId,
        data: { label: label(cam.name ?? cam.mac ?? cam.id, sub, t) },
        position: { x: 0, y: 0 },
        style: nodeStyle('camera', cam.online, t),
      });
      edges.push({
        id: `ecam-${cam.id}`,
        source: parent,
        target: camId,
        style: { stroke: cam.online ? CAM_ACCENT : t.line, strokeWidth: 1.2, strokeDasharray: '4 3' },
      });
    }
  }
  return { nodes: layout(nodes, edges), edges };
}

function Flow() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'network');

  const [devices, setDevices] = useState<UniFiDevice[]>([]);
  const [clients, setClients] = useState<UniFiClient[]>([]);
  const [cameras, setCameras] = useState<TopoCamera[]>([]);
  const [showWired, setShowWired] = useState(false);
  const [showWireless, setShowWireless] = useState(false);
  const [showCameras, setShowCameras] = useState(false);
  const [present, setPresent] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/unifi');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setPresent(!!j.present);
      setDevices(j.reading?.raw?.devices ?? []);
      setClients(j.reading?.raw?.clients ?? []);
    } catch {
      setPresent((p) => p ?? false);
    }
    // Cameras are a separate, optional feed — a missing/empty Protect snapshot
    // must never break the network graph.
    try {
      const r = await apiFetch('/api/protect');
      if (!r.ok) return;
      const j = await r.json();
      setCameras(j.present ? (j.cameras ?? []) : []);
    } catch { /* Protect is optional */ }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const graph = useMemo(
    () => buildGraph(devices, clients, cameras, showWired, showWireless, showCameras, t),
    [devices, clients, cameras, showWired, showWireless, showCameras, t],
  );
  useEffect(() => { setNodes(graph.nodes); setEdges(graph.edges); }, [graph, setNodes, setEdges]);

  const onNodeClick = useCallback<NodeMouseHandler>((_, node) => {
    if (node.id.startsWith('cam-')) return; // Protect cameras have no network detail
    if (node.id.startsWith('c-')) {
      const cl = clients.find((c) => `c-${c.id}` === node.id);
      if (cl) setDetail({ kind: 'client', data: cl });
    } else {
      const dv = devices.find((d) => d.id === node.id);
      if (dv) setDetail({ kind: 'device', data: dv });
    }
  }, [devices, clients]);

  const deviceCount = devices.length;
  const wiredCount = clients.filter((c) => c.wired).length;
  const wirelessCount = clients.length - wiredCount;

  return (
    <Box sx={{ height: 'calc(100vh - 320px)', minHeight: 420, borderRadius: CARD_RADIUS, overflow: 'hidden', border: `1px solid ${t.line}`, background: t.bg, position: 'relative' }}>
      <Box sx={{ position: 'absolute', zIndex: 5, top: 12, left: 12, display: 'flex', gap: 0.75, flexWrap: 'wrap', maxWidth: 'calc(100% - 24px)' }}>
        <Chip label={`${deviceCount} devices`} size="small"
          sx={{ fontWeight: 700, fontSize: '0.72rem', bgcolor: t.paper, color: t.ink, border: `1px solid ${t.line}` }} />
        <Chip icon={<WiredIcon sx={{ fontSize: '0.9rem !important', color: showWired ? '#fff !important' : `${t.muted} !important` }} />}
          label={showWired ? 'Hide wired' : `Wired (${wiredCount})`} size="small" onClick={() => setShowWired((s) => !s)}
          sx={{ fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer',
            bgcolor: showWired ? t.rust : 'transparent', color: showWired ? '#fff' : t.muted,
            border: `1px solid ${showWired ? t.rust : t.line}`, '&:hover': { bgcolor: showWired ? t.rustDark : `${t.rust}22` } }} />
        <Chip icon={<WirelessIcon sx={{ fontSize: '0.9rem !important', color: showWireless ? '#fff !important' : `${t.muted} !important` }} />}
          label={showWireless ? 'Hide wireless' : `Wireless (${wirelessCount})`} size="small" onClick={() => setShowWireless((s) => !s)}
          sx={{ fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer',
            bgcolor: showWireless ? t.champagne : 'transparent', color: showWireless ? '#fff' : t.muted,
            border: `1px solid ${showWireless ? t.champagne : t.line}`, '&:hover': { bgcolor: showWireless ? t.champagne : `${t.champagne}22` } }} />
        {cameras.length > 0 && (
          <Chip icon={<CameraIcon sx={{ fontSize: '0.9rem !important', color: showCameras ? '#fff !important' : `${CAM_ACCENT} !important` }} />}
            label={showCameras ? 'Hide cameras' : `Show cameras (${cameras.length})`} size="small" onClick={() => setShowCameras((s) => !s)}
            sx={{ fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer',
              bgcolor: showCameras ? CAM_ACCENT : 'transparent', color: showCameras ? '#fff' : t.muted,
              border: `1px solid ${showCameras ? CAM_ACCENT : t.line}`, '&:hover': { bgcolor: showCameras ? CAM_ACCENT : `${CAM_ACCENT}22` } }} />
        )}
      </Box>
      {present === false && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 4 }}>
          <Scrim>
            <Typography sx={{ fontSize: '0.9rem', color: t.muted }}>Waiting for the first reading from the UniFi agent…</Typography>
          </Scrim>
        </Box>
      )}
      {present === null && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 4 }}>
          <CircularProgress size={28} sx={{ color: t.rust }} />
        </Box>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={t.line} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => t.rust} maskColor={isDark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.5)'}
          style={{ background: t.paper, border: `1px solid ${t.line}` }} />
      </ReactFlow>
      <DetailDrawer t={t} isDark={isDark} detail={detail} onClose={() => setDetail(null)} onOpen={setDetail} devices={devices} clients={clients} />
    </Box>
  );
}

export default function UniFiTopology() {
  const { mode } = useThemeMode();
  const t = tokensFor(mode === 'dark', 'network');
  return (
    <Box sx={pageShellSx(true)}>
      <PageHero
        eyebrow="UniFi Network"
        title="Network topology"
        accentPhrase="topology"
        subtitle="Auto-generated map of your network — gateway, switches, and access points, wired by their uplinks. Toggle clients or Protect cameras to see everything attached."
      />
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
      <Scrim sx={{ mt: 1.5 }}>
        <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>
          Layout is derived from each device's reported uplink. Per-port wiring and client-to-port detail become exact once the legacy API is enabled on the agent.
        </Typography>
      </Scrim>
    </Box>
  );
}
