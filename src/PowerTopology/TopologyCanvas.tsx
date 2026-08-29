// React Flow canvas for a power-topology diagram.
//
// Converts PowerItems → nodes and PowerConnections → edges, and wires the
// interactions back to the parent:
//   • drag a plug (source) onto a device's power-in (target) → create a cable
//   • drag an existing cable's endpoint to another plug → move it (reconnect)
//   • drag a cable's endpoint off onto empty canvas → unplug (delete)
//   • drag a node → persist its new position on drop
//   • select a node → open it in the edit form
//   • Delete / Backspace on a selected node or cable → remove it
//
// Cables render an arrowhead pointing provider → consumer (power-flow direction)
// and animate to suggest current flowing along the wire. Connected plugs and
// powered devices are shown in green by the node component.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  getNodesBounds,
  getViewportForBounds,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  Box,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  GridOn as GridIcon,
  PowerOff as OutageIcon,
  AutoFixHigh as LayoutIcon,
  Download as ExportIcon,
  CropSquare as ZoneIcon,
  ContentCopy as DuplicateIcon,
  Edit as EditIcon,
  DeleteOutline as DeleteIcon,
} from '@mui/icons-material';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import ItemNode from './nodes/ItemNode';
import ZoneNode from './nodes/ZoneNode';
import type { ReconnectConnectionPayload } from './api';
import { computeLoads, computePowerStates } from './analysis';
import { KIND_META, type LiveUps, type PowerConnection, type PowerItem, type Zone } from './types';

const nodeTypes: NodeTypes = { item: ItemNode, zone: ZoneNode };

interface CanvasProps {
  items: PowerItem[];
  connections: PowerConnection[];
  zones: Zone[];
  liveUps: Record<string, LiveUps>;
  diagramName: string;
  onCreateConnection: (payload: ReconnectConnectionPayload) => void;
  onReconnectConnection: (id: number, payload: ReconnectConnectionPayload) => void;
  onDeleteConnection: (id: number) => void;
  onEditConnection: (connection: PowerConnection) => void;
  onMoveItem: (id: number, x: number, y: number) => void;
  onBulkMove: (positions: { id: number; pos_x: number; pos_y: number }[]) => void;
  onDeleteItem: (id: number) => void;
  onDuplicateItem: (item: PowerItem) => void;
  onSelectItem: (item: PowerItem | null) => void;
  selectedItemId: number | null;
  onCreateZone: (x: number, y: number) => void;
  onZoneChange: (id: number, patch: { pos_x?: number; pos_y?: number; width?: number; height?: number }) => void;
  onRenameZone: (zone: Zone) => void;
  onDeleteZone: (id: number) => void;
  /** View-only: the diagram can be read, panned and exported but not changed. */
  readOnly: boolean;
}

function toEdge(c: PowerConnection, defaultStroke: string, ink: string, paper: string): Edge {
  const stroke = c.color || defaultStroke;
  return {
    id: `c${c.id}`,
    source: String(c.source_item_id),
    sourceHandle: `plug-${c.source_plug_index}`,
    target: String(c.target_item_id),
    targetHandle: 'in',
    animated: true,
    reconnectable: true,
    label: c.label || undefined,
    labelStyle: { fill: ink, fontSize: 10, fontWeight: 700 },
    labelBgStyle: { fill: paper, fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
    style: { stroke, strokeWidth: 2 },
    data: { connectionId: c.id },
  };
}

function InnerCanvas({
  items,
  connections,
  zones,
  liveUps,
  diagramName,
  onCreateConnection,
  onReconnectConnection,
  onDeleteConnection,
  onEditConnection,
  onMoveItem,
  onBulkMove,
  onDeleteItem,
  onDuplicateItem,
  onSelectItem,
  selectedItemId,
  onCreateZone,
  onZoneChange,
  onRenameZone,
  onDeleteZone,
  readOnly,
}: CanvasProps) {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');
  const rf = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [snap, setSnap] = useState(false);
  const [outage, setOutage] = useState(false);
  const [search, setSearch] = useState('');
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; type: 'node' | 'edge' | 'zone'; id: number } | null>(null);

  // Derive, per provider, which device name is plugged into each plug, plus the
  // set of items that are currently powered — used to colour plugs/handles green.
  const { plugTargetsByItem, poweredIds } = useMemo(() => {
    const nameById = new Map(items.map((i) => [i.id, i.name]));
    const plugMap = new Map<number, (string | null)[]>();
    const powered = new Set<number>();
    for (const it of items) {
      if (KIND_META[it.kind].providesPlugs) plugMap.set(it.id, new Array(it.plug_count).fill(null));
    }
    for (const c of connections) {
      powered.add(c.target_item_id);
      const arr = plugMap.get(c.source_item_id);
      if (arr && c.source_plug_index < arr.length) {
        arr[c.source_plug_index] = nameById.get(c.target_item_id) ?? null;
      }
    }
    return { plugTargetsByItem: plugMap, poweredIds: powered };
  }, [items, connections]);

  // Load rollups (always) + outage power states (only when the outage view is on).
  const loads = useMemo(() => computeLoads(items, connections), [items, connections]);
  const powerStates = useMemo(
    () => (outage ? computePowerStates(items, connections) : null),
    [outage, items, connections],
  );

  // Rebuild nodes: zone backgrounds first (behind), then item nodes.
  useEffect(() => {
    const zoneNodes: Node[] = zones.map((z) => ({
      id: `z${z.id}`,
      type: 'zone',
      position: { x: z.pos_x, y: z.pos_y },
      width: z.width,
      height: z.height,
      style: { width: z.width, height: z.height },
      zIndex: 0,
      // Per-node `draggable` wins over the canvas-level `nodesDraggable`, so
      // this has to be gated too or zones stay movable while items freeze.
      draggable: !readOnly,
      selectable: true,
      data: {
        zone: z,
        readOnly,
        onResizeCommit: (patch: { pos_x: number; pos_y: number; width: number; height: number }) =>
          onZoneChange(z.id, patch),
      },
    }));
    const itemNodes: Node[] = items.map((it) => {
      const cap = it.watts;
      const load = KIND_META[it.kind].providesPlugs ? loads.get(it.id) ?? 0 : null;
      const overloaded = cap != null && load != null && load > cap;
      return {
        id: String(it.id),
        type: 'item',
        position: { x: it.pos_x, y: it.pos_y },
        zIndex: 1,
        selected: it.id === selectedItemId,
        data: {
          item: it,
          plugTargets: plugTargetsByItem.get(it.id) ?? [],
          isPowered: poweredIds.has(it.id),
          load,
          overloaded,
          powerState: powerStates ? powerStates.get(it.id) ?? 'unknown' : null,
          liveUps: it.kind === 'ups' && it.link_live && it.ups_id ? (liveUps[it.ups_id] ?? null) : null,
        },
      };
    });
    setNodes([...zoneNodes, ...itemNodes]);
  }, [items, zones, selectedItemId, plugTargetsByItem, poweredIds, loads, powerStates, liveUps, onZoneChange, setNodes, readOnly]);

  useEffect(() => {
    setEdges(connections.map((c) => toEdge(c, t.rust, t.ink, t.paper)));
  }, [connections, t.rust, t.ink, t.paper, setEdges]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle) return;
      const plugIndex = Number(c.sourceHandle.replace('plug-', ''));
      if (!Number.isInteger(plugIndex)) return;
      onCreateConnection({
        source_item_id: Number(c.source),
        source_plug_index: plugIndex,
        target_item_id: Number(c.target),
      });
    },
    [onCreateConnection],
  );

  // Cable reconnection: drag an endpoint to a new plug/device to move it, or drop
  // it on empty canvas to unplug. `reconnectDone` distinguishes the two: it stays
  // false when the drag doesn't land on a valid handle.
  const reconnectDone = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectDone.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge: Edge, nc: Connection) => {
      reconnectDone.current = true;
      const id = (oldEdge.data as { connectionId?: number } | undefined)?.connectionId;
      if (!id || !nc.source || !nc.target || !nc.sourceHandle) return;
      const plugIndex = Number(nc.sourceHandle.replace('plug-', ''));
      if (!Number.isInteger(plugIndex)) return;
      onReconnectConnection(id, {
        source_item_id: Number(nc.source),
        source_plug_index: plugIndex,
        target_item_id: Number(nc.target),
      });
    },
    [onReconnectConnection],
  );
  const onReconnectEnd = useCallback(
    (_e: MouseEvent | TouchEvent, edge: Edge) => {
      if (!reconnectDone.current) {
        const id = (edge.data as { connectionId?: number } | undefined)?.connectionId;
        if (id) onDeleteConnection(id);
      }
      reconnectDone.current = true;
    },
    [onDeleteConnection],
  );

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_e, node) => {
      if (node.type === 'zone') {
        onZoneChange(Number(node.id.slice(1)), { pos_x: node.position.x, pos_y: node.position.y });
      } else {
        onMoveItem(Number(node.id), node.position.x, node.position.y);
      }
    },
    [onMoveItem, onZoneChange],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      deleted.forEach((n) => {
        if (n.type === 'zone') onDeleteZone(Number(n.id.slice(1)));
        else onDeleteItem(Number(n.id));
      });
    },
    [onDeleteItem, onDeleteZone],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      deleted.forEach((e) => {
        const id = (e.data as { connectionId?: number } | undefined)?.connectionId;
        if (id) onDeleteConnection(id);
      });
    },
    [onDeleteConnection],
  );

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type === 'zone') {
        onSelectItem(null);
        return;
      }
      const found = items.find((it) => it.id === Number(node.id)) ?? null;
      onSelectItem(found);
    },
    [items, onSelectItem],
  );

  const onPaneClick = useCallback(() => {
    onSelectItem(null);
    setMenu(null);
  }, [onSelectItem]);

  // The context menus and the cable dialog are edit-only surfaces, so a
  // view-only user never gets them — a menu of disabled items is worse than no
  // menu. Clicking a node still opens its (read-only) detail form.
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    if (readOnly) return;
    if (node.type === 'zone') setMenu({ x: e.clientX, y: e.clientY, type: 'zone', id: Number(node.id.slice(1)) });
    else setMenu({ x: e.clientX, y: e.clientY, type: 'node', id: Number(node.id) });
  }, [readOnly]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    if (readOnly) return;
    const id = (edge.data as { connectionId?: number } | undefined)?.connectionId;
    if (id) setMenu({ x: e.clientX, y: e.clientY, type: 'edge', id });
  }, [readOnly]);

  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      if (readOnly) return;
      const id = (edge.data as { connectionId?: number } | undefined)?.connectionId;
      const conn = connections.find((c) => c.id === id);
      if (conn) onEditConnection(conn);
    },
    [connections, onEditConnection, readOnly],
  );

  const runSearch = useCallback(() => {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const match = items.find((it) => it.name.toLowerCase().includes(q));
    if (!match) return;
    const w = KIND_META[match.kind].providesPlugs ? Math.max(190, match.plug_count * 52) : 190;
    void rf.setCenter(match.pos_x + w / 2, match.pos_y + 45, { zoom: 1.2, duration: 500 });
    onSelectItem(match);
  }, [search, items, rf, onSelectItem]);

  const handleAutoLayout = useCallback(async () => {
    if (items.length === 0) return;
    const { computeLayout } = await import('./layout');
    const pos = computeLayout(items, connections);
    const positions = items
      .map((it) => {
        const p = pos.get(it.id);
        return p ? { id: it.id, pos_x: p.x, pos_y: p.y } : null;
      })
      .filter((p): p is { id: number; pos_x: number; pos_y: number } => p !== null);
    onBulkMove(positions);
    window.setTimeout(() => rf.fitView({ padding: 0.3, duration: 400 }), 60);
  }, [items, connections, onBulkMove, rf]);

  const addZone = useCallback(() => {
    const vp = rf.getViewport();
    const el = document.querySelector<HTMLElement>('.react-flow');
    const cw = el?.clientWidth ?? 800;
    const ch = el?.clientHeight ?? 600;
    const fx = (cw / 2 - vp.x) / vp.zoom - 160;
    const fy = (ch / 2 - vp.y) / vp.zoom - 110;
    onCreateZone(Math.round(fx), Math.round(fy));
  }, [rf, onCreateZone]);

  const exportImage = useCallback(
    async (format: 'png' | 'svg' | 'pdf') => {
      setExportAnchor(null);
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
      const nodesList = rf.getNodes();
      if (!viewport || nodesList.length === 0) return;
      const bounds = getNodesBounds(nodesList);
      const pad = 80;
      const width = Math.ceil(bounds.width) + pad * 2;
      const height = Math.ceil(bounds.height) + pad * 2;
      const vp = getViewportForBounds(bounds, width, height, 0.2, 2, 0.1);
      const style = {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
      };
      const filename = (diagramName || 'topology').replace(/[^\w-]+/g, '_');
      try {
        const { toPng, toSvg } = await import('html-to-image');
        if (format === 'svg') {
          const url = await toSvg(viewport, { backgroundColor: t.bg, width, height, style });
          triggerDownload(url, `${filename}.svg`);
        } else {
          const url = await toPng(viewport, { backgroundColor: t.bg, width, height, style, pixelRatio: 2 });
          if (format === 'png') {
            triggerDownload(url, `${filename}.png`);
          } else {
            const { jsPDF } = await import('jspdf');
            const pdf = new jsPDF({
              orientation: width >= height ? 'landscape' : 'portrait',
              unit: 'px',
              format: [width, height],
            });
            pdf.addImage(url, 'PNG', 0, 0, width, height);
            pdf.save(`${filename}.pdf`);
          }
        }
      } catch {
        /* ignore export errors */
      }
    },
    [rf, t.bg, diagramName],
  );

  const defaultEdgeOptions = useMemo(
    () => ({ style: { stroke: t.rust, strokeWidth: 2 } }),
    [t.rust],
  );

  const menuItem = items.find((it) => it.id === menu?.id);
  const menuZone = zones.find((z) => z.id === menu?.id);
  const menuConn = connections.find((c) => c.id === menu?.id);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onReconnectStart={onReconnectStart}
      onReconnect={onReconnect}
      onReconnectEnd={onReconnectEnd}
      onNodeDragStop={onNodeDragStop}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onEdgeDoubleClick={onEdgeDoubleClick}
      onPaneClick={onPaneClick}
      defaultEdgeOptions={defaultEdgeOptions}
      colorMode={isDark ? 'dark' : 'light'}
      // Read-only still pans, zooms, selects and exports — it just cannot move a
      // node, draw a cable, or delete anything with the keyboard.
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      edgesReconnectable={!readOnly}
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      snapToGrid={snap}
      snapGrid={[16, 16]}
      minZoom={0.1}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color={t.line} />
      <Controls showInteractive={false} />
      <MiniMap
        position="top-right"
        pannable
        zoomable
        nodeColor={t.rust}
        maskColor={isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)'}
        style={{ background: t.surface }}
      />

      <Panel position="top-left">
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            p: 0.5,
            borderRadius: 2,
            background: `${t.paper}E6`,
            border: `1px solid ${t.line}`,
            backdropFilter: 'blur(6px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}
        >
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
            size="small"
            placeholder="Search…"
            sx={{
              width: 130,
              '& .MuiOutlinedInput-root': { height: 30, fontSize: '0.78rem', background: t.paper, color: t.ink },
              '& fieldset': { borderColor: t.line },
            }}
          />
          <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
          <Tooltip title="Snap to grid">
            <IconButton size="small" onClick={() => setSnap((s) => !s)} sx={{ color: snap ? t.rust : t.muted }}>
              <GridIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Outage view — highlight what survives a power cut">
            <IconButton size="small" onClick={() => setOutage((o) => !o)} sx={{ color: outage ? t.rust : t.muted }}>
              <OutageIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Auto-layout">
            <span>
              <IconButton size="small" disabled={readOnly} onClick={handleAutoLayout} sx={{ color: t.muted }}>
                <LayoutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Add zone">
            <span>
              <IconButton size="small" disabled={readOnly} onClick={addZone} sx={{ color: t.muted }}>
                <ZoneIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Export">
            <IconButton size="small" onClick={(e) => setExportAnchor(e.currentTarget)} sx={{ color: t.muted }}>
              <ExportIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        {outage && (
          <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75, px: 0.5, fontSize: '0.66rem', color: t.inkSoft }}>
            <span style={{ color: isDark ? '#43C97D' : '#2E9E5B', fontWeight: 700 }}>■ Protected</span>
            <span style={{ color: isDark ? '#F0776E' : '#C4443A', fontWeight: 700 }}>■ Exposed</span>
          </Box>
        )}
      </Panel>

      <Menu anchorEl={exportAnchor} open={Boolean(exportAnchor)} onClose={() => setExportAnchor(null)}>
        <MenuItem onClick={() => exportImage('png')}>Export PNG</MenuItem>
        <MenuItem onClick={() => exportImage('svg')}>Export SVG</MenuItem>
        <MenuItem onClick={() => exportImage('pdf')}>Export PDF</MenuItem>
      </Menu>

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        {menu?.type === 'node' && [
          <MenuItem
            key="edit"
            onClick={() => {
              if (menuItem) onSelectItem(menuItem);
              setMenu(null);
            }}
          >
            <EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit
          </MenuItem>,
          <MenuItem
            key="dup"
            onClick={() => {
              if (menuItem) onDuplicateItem(menuItem);
              setMenu(null);
            }}
          >
            <DuplicateIcon fontSize="small" sx={{ mr: 1 }} /> Duplicate
          </MenuItem>,
          <MenuItem
            key="del"
            onClick={() => {
              if (menu) onDeleteItem(menu.id);
              setMenu(null);
            }}
          >
            <DeleteIcon fontSize="small" sx={{ mr: 1 }} /> Delete
          </MenuItem>,
        ]}
        {menu?.type === 'zone' && [
          <MenuItem
            key="rename"
            onClick={() => {
              if (menuZone) onRenameZone(menuZone);
              setMenu(null);
            }}
          >
            <EditIcon fontSize="small" sx={{ mr: 1 }} /> Rename zone
          </MenuItem>,
          <MenuItem
            key="delz"
            onClick={() => {
              if (menu) onDeleteZone(menu.id);
              setMenu(null);
            }}
          >
            <DeleteIcon fontSize="small" sx={{ mr: 1 }} /> Delete zone
          </MenuItem>,
        ]}
        {menu?.type === 'edge' && [
          <MenuItem
            key="editc"
            onClick={() => {
              if (menuConn) onEditConnection(menuConn);
              setMenu(null);
            }}
          >
            <EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit cable
          </MenuItem>,
          <MenuItem
            key="delc"
            onClick={() => {
              if (menu) onDeleteConnection(menu.id);
              setMenu(null);
            }}
          >
            <DeleteIcon fontSize="small" sx={{ mr: 1 }} /> Delete cable
          </MenuItem>,
        ]}
      </Menu>
    </ReactFlow>
  );
}

function triggerDownload(dataUrl: string, name: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

export default function TopologyCanvas(props: CanvasProps) {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');
  const isMobile = useMediaQuery('(max-width:900px)');
  const boxRef = useRef<HTMLDivElement>(null);

  // Restore the last dragged canvas size (persisted below via ResizeObserver).
  const initial = useMemo(() => readCanvasSize(), []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || isMobile) return;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => saveCanvasSize(el.offsetWidth, el.offsetHeight), 300);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [isMobile]);

  return (
    <Box
      ref={boxRef}
      sx={{
        position: 'relative',
        width: isMobile ? '100%' : initial.w,
        height: isMobile ? '60vh' : initial.h,
        minWidth: 360,
        minHeight: 380,
        maxWidth: '100%',
        resize: isMobile ? 'none' : 'both',
        overflow: 'hidden',
        borderRadius: 2,
        border: `1px solid ${t.line}`,
        background: t.bg,
        '& .react-flow__attribution': { display: 'none' },
        // Visual affordance for the native resize grip (bottom-right corner).
        '&::after': {
          content: '""',
          position: 'absolute',
          right: 4,
          bottom: 4,
          width: 11,
          height: 11,
          borderRight: `2px solid ${t.muted}`,
          borderBottom: `2px solid ${t.muted}`,
          opacity: 0.6,
          pointerEvents: 'none',
          display: isMobile ? 'none' : 'block',
        },
      }}
    >
      <ReactFlowProvider>
        <InnerCanvas {...props} />
      </ReactFlowProvider>

      {props.items.length === 0 && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            px: 3,
          }}
        >
          <Typography
            sx={{ color: t.muted, fontSize: '0.9rem', textAlign: 'center', maxWidth: 320 }}
          >
            Add your first item with the form{isMobile ? ' below' : ' on the right'} — a wall
            outlet is a good place to start.
          </Typography>
        </Box>
      )}
    </Box>
  );
}

// ── Canvas size persistence ──────────────────────────────────────────────────
const SIZE_KEY = 'watchtower.powerTopology.canvasSize';

function readCanvasSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Number.isFinite(o.w) && Number.isFinite(o.h)) {
        return { w: Math.max(360, o.w), h: Math.max(380, o.h) };
      }
    }
  } catch {
    /* ignore */
  }
  return { w: 1100, h: 640 };
}

function saveCanvasSize(w: number, h: number) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
  } catch {
    /* ignore */
  }
}
