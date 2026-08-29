// Power Topology — a Visio-style canvas for mapping how everything in a room is
// powered: devices, power strips, UPSes and wall outlets, wired together with
// power cables. Create items in the form (they drop onto the canvas), drag them
// around, and draw a cable from a provider's plug to a device's power-in.
//
// Data + interactions:
//   • Multiple named diagrams (selector in the header).
//   • All state is persisted through routes/power-topology.js (/api/power/*).
//   • Purely a wiring diagram — no wattage/load math.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Snackbar,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import '@xyflow/react/dist/style.css';
import {
  AddCircleOutline as NewIcon,
  DriveFileRenameOutline as RenameIcon,
  DeleteOutline as DeleteIcon,
  ContentCopy as DuplicateIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
} from '@mui/icons-material';
import PageHero from '../components/PageHero';
import Scrim from '../components/Scrim';
import { useThemeMode } from '../context/ThemeContext';
import { useReadOnly } from '../context/UserPermissionsContext';
import { tokensFor } from '../theme/tokens';
import TopologyCanvas from './TopologyCanvas';
import ItemForm from './ItemForm';
import {
  powerApi,
  type CreateConnectionPayload,
  type CreateItemPayload,
  type ReconnectConnectionPayload,
  type UpdateItemPayload,
} from './api';
import type { Diagram, LiveUps, PowerConnection, PowerItem, Zone } from './types';
import { CARD_HOVER_SX, pageShellSx } from '../theme/controls';

type Snapshot = { items: PowerItem[]; connections: PowerConnection[]; zones: Zone[] };
type ConnDialogState = { id: number; label: string; color: string } | null;
type ZoneDialogState = { id: number; value: string } | null;

// Preset circuit/breaker colors for cables and zones.
const CIRCUIT_COLORS = ['#3AA0FF', '#43C97D', '#E6A63A', '#C77AA0', '#F0776E', '#9B8CFF', '#5BC0BE'];

type DialogState =
  | { mode: 'create'; value: string }
  | { mode: 'rename'; value: string }
  | { mode: 'duplicate'; value: string }
  | { mode: 'delete' }
  | null;

export default function PowerTopology() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');
  const readOnly = useReadOnly('power-topology');

  const [diagrams, setDiagrams] = useState<Diagram[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [items, setItems] = useState<PowerItem[]>([]);
  const [connections, setConnections] = useState<PowerConnection[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [liveUps, setLiveUps] = useState<Record<string, LiveUps>>({});
  const [selected, setSelected] = useState<PowerItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [connDialog, setConnDialog] = useState<ConnDialogState>(null);
  const [zoneDialog, setZoneDialog] = useState<ZoneDialogState>(null);

  // Undo/redo history of full-graph snapshots (applied via the replace-graph API).
  const graphRef = useRef<Snapshot>({ items: [], connections: [], zones: [] });
  graphRef.current = { items, connections, zones };
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const [, setHistVer] = useState(0);

  const cloneGraph = (g: Snapshot): Snapshot => ({
    items: g.items.map((x) => ({ ...x })),
    connections: g.connections.map((x) => ({ ...x })),
    zones: g.zones.map((x) => ({ ...x })),
  });
  const record = useCallback(() => {
    pastRef.current = [...pastRef.current.slice(-49), cloneGraph(graphRef.current)];
    futureRef.current = [];
    setHistVer((v) => v + 1);
  }, []);

  const currentDiagram = diagrams.find((d) => d.id === currentId) ?? null;
  const showError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  // Load the diagram list on mount, auto-selecting the most recent one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await powerApi.listDiagrams();
        if (cancelled) return;
        setDiagrams(list);
        setCurrentId((prev) => prev ?? (list[0]?.id ?? null));
      } catch (e) {
        if (!cancelled) showError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showError]);

  // Load the selected diagram's graph.
  useEffect(() => {
    if (currentId == null) {
      setItems([]);
      setConnections([]);
      setZones([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const graph = await powerApi.getGraph(currentId);
        if (cancelled) return;
        setItems(graph.items);
        setConnections(graph.connections);
        setZones(graph.zones ?? []);
        setSelected(null);
        pastRef.current = [];
        futureRef.current = [];
        setHistVer((v) => v + 1);
      } catch (e) {
        if (!cancelled) showError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId, showError]);

  // Poll the live UPS feed while any linked UPS is on the diagram.
  const hasLinkedUps = useMemo(
    () => items.some((it) => it.kind === 'ups' && it.link_live),
    [items],
  );
  useEffect(() => {
    if (!hasLinkedUps) {
      setLiveUps({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const d = await powerApi.getLiveUps();
      if (!cancelled) setLiveUps(d);
    };
    void load();
    const id = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasLinkedUps]);

  // Cascade new items across the canvas so they don't stack exactly.
  const nextPosition = useCallback(() => {
    const n = items.length;
    return { x: 80 + (n % 6) * 64, y: 60 + Math.floor(n / 6) * 56 };
  }, [items.length]);

  // ── Item mutations ─────────────────────────────────────────────────────────
  const handleCreateItem = useCallback(
    async (payload: Omit<CreateItemPayload, 'diagram_id'>) => {
      if (currentId == null) return;
      record();
      try {
        const pos = nextPosition();
        const item = await powerApi.createItem({
          diagram_id: currentId,
          ...payload,
          pos_x: pos.x,
          pos_y: pos.y,
        });
        setItems((prev) => [...prev, item]);
      } catch (e) {
        showError(e);
      }
    },
    [currentId, nextPosition, record, showError],
  );

  const handleUpdateItem = useCallback(
    async (id: number, payload: UpdateItemPayload) => {
      record();
      try {
        const updated = await powerApi.updateItem(id, payload);
        setItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
        setSelected(updated);
      } catch (e) {
        showError(e);
      }
    },
    [record, showError],
  );

  const handleDeleteItem = useCallback(
    async (id: number) => {
      record();
      try {
        await powerApi.deleteItem(id);
        setItems((prev) => prev.filter((it) => it.id !== id));
        setConnections((prev) =>
          prev.filter((c) => c.source_item_id !== id && c.target_item_id !== id),
        );
        setSelected((cur) => (cur?.id === id ? null : cur));
      } catch (e) {
        showError(e);
      }
    },
    [record, showError],
  );

  const handleMoveItem = useCallback(
    (id: number, x: number, y: number) => {
      record();
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, pos_x: x, pos_y: y } : it)));
      powerApi.updateItem(id, { pos_x: x, pos_y: y }).catch(showError);
    },
    [record, showError],
  );

  // ── Connection mutations ───────────────────────────────────────────────────
  const handleCreateConnection = useCallback(
    async (payload: Omit<CreateConnectionPayload, 'diagram_id'>) => {
      if (currentId == null) return;
      record();
      try {
        const conn = await powerApi.createConnection({ diagram_id: currentId, ...payload });
        setConnections((prev) => [...prev, conn]);
      } catch (e) {
        showError(e);
      }
    },
    [currentId, record, showError],
  );

  const handleDeleteConnection = useCallback(
    (id: number) => {
      record();
      setConnections((prev) => prev.filter((c) => c.id !== id));
      // May already be gone via cascade when its item was deleted — ignore errors.
      powerApi.deleteConnection(id).catch(() => {});
    },
    [record],
  );

  // Move a cable to a different plug and/or device (drag an endpoint on canvas).
  const handleReconnectConnection = useCallback(
    async (id: number, payload: ReconnectConnectionPayload) => {
      if (currentId == null) return;
      record();
      try {
        const updated = await powerApi.reconnectConnection(id, payload);
        setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (e) {
        // Snap the cable back to its stored wiring by forcing an edge rebuild.
        setConnections((prev) => prev.slice());
        showError(e);
      }
    },
    [currentId, record, showError],
  );

  const handleUpdateConnectionMeta = useCallback(
    async (id: number, payload: { label?: string | null; color?: string | null }) => {
      record();
      try {
        const updated = await powerApi.updateConnectionMeta(id, payload);
        setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (e) {
        showError(e);
      }
    },
    [record, showError],
  );

  const handleDuplicateItem = useCallback(
    async (item: PowerItem) => {
      if (currentId == null) return;
      record();
      try {
        const created = await powerApi.createItem({
          diagram_id: currentId,
          name: `${item.name} (copy)`,
          kind: item.kind,
          subtype: item.subtype,
          plug_count: item.plug_count,
          plug_labels: item.plug_labels,
          watts: item.watts,
          link_live: Boolean(item.link_live),
          pos_x: item.pos_x + 40,
          pos_y: item.pos_y + 40,
          notes: item.notes,
        });
        setItems((prev) => [...prev, created]);
      } catch (e) {
        showError(e);
      }
    },
    [currentId, record, showError],
  );

  const handleBulkMove = useCallback(
    async (positions: { id: number; pos_x: number; pos_y: number }[]) => {
      record();
      setItems((prev) =>
        prev.map((it) => {
          const p = positions.find((pp) => pp.id === it.id);
          return p ? { ...it, pos_x: p.pos_x, pos_y: p.pos_y } : it;
        }),
      );
      try {
        await powerApi.bulkPositions(positions);
      } catch (e) {
        showError(e);
      }
    },
    [record, showError],
  );

  // ── Zone mutations ─────────────────────────────────────────────────────────
  const handleCreateZone = useCallback(
    async (x: number, y: number) => {
      if (currentId == null) return;
      record();
      try {
        const zone = await powerApi.createZone(currentId, { pos_x: x, pos_y: y });
        setZones((prev) => [...prev, zone]);
      } catch (e) {
        showError(e);
      }
    },
    [currentId, record, showError],
  );

  const handleZoneChange = useCallback(
    (id: number, patch: { pos_x?: number; pos_y?: number; width?: number; height?: number }) => {
      record();
      setZones((prev) => prev.map((z) => (z.id === id ? { ...z, ...patch } : z)));
      powerApi.updateZone(id, patch).catch(showError);
    },
    [record, showError],
  );

  const handleDeleteZone = useCallback(
    (id: number) => {
      record();
      setZones((prev) => prev.filter((z) => z.id !== id));
      powerApi.deleteZone(id).catch(showError);
    },
    [record, showError],
  );

  // ── Undo / redo (full-graph snapshots via the replace-graph API) ────────────
  const applySnapshot = useCallback(
    async (snap: Snapshot) => {
      if (currentId == null) return;
      try {
        const res = await powerApi.replaceGraph(currentId, snap);
        setItems(res.items);
        setConnections(res.connections);
        setZones(res.zones);
        setSelected(null);
      } catch (e) {
        showError(e);
      }
    },
    [currentId, showError],
  );

  const undo = useCallback(() => {
    const prev = pastRef.current[pastRef.current.length - 1];
    if (!prev) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, cloneGraph(graphRef.current)];
    setHistVer((v) => v + 1);
    void applySnapshot(prev);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const next = futureRef.current[futureRef.current.length - 1];
    if (!next) return;
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, cloneGraph(graphRef.current)];
    setHistVer((v) => v + 1);
    void applySnapshot(next);
  }, [applySnapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, readOnly]);

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  const submitConnEdit = useCallback(() => {
    if (!connDialog) return;
    void handleUpdateConnectionMeta(connDialog.id, {
      label: connDialog.label.trim() || null,
      color: connDialog.color || null,
    });
    setConnDialog(null);
  }, [connDialog, handleUpdateConnectionMeta]);

  const submitZoneRename = useCallback(() => {
    if (!zoneDialog || !zoneDialog.value.trim()) return;
    const { id, value } = zoneDialog;
    record();
    setZones((prev) => prev.map((z) => (z.id === id ? { ...z, name: value.trim() } : z)));
    powerApi.updateZone(id, { name: value.trim() }).catch(showError);
    setZoneDialog(null);
  }, [zoneDialog, record, showError]);

  // ── Diagram mutations ──────────────────────────────────────────────────────
  const submitDialog = useCallback(async () => {
    if (!dialog) return;
    try {
      if (dialog.mode === 'create') {
        const name = dialog.value.trim();
        if (!name) return;
        const created = await powerApi.createDiagram(name);
        setDiagrams((prev) => [created, ...prev]);
        setCurrentId(created.id);
      } else if (dialog.mode === 'duplicate' && currentId != null) {
        const name = dialog.value.trim();
        if (!name) return;
        const created = await powerApi.duplicateDiagram(currentId, name);
        setDiagrams((prev) => [created, ...prev]);
        setCurrentId(created.id);
      } else if (dialog.mode === 'rename' && currentId != null) {
        const name = dialog.value.trim();
        if (!name) return;
        const updated = await powerApi.renameDiagram(currentId, name);
        setDiagrams((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      } else if (dialog.mode === 'delete' && currentId != null) {
        await powerApi.deleteDiagram(currentId);
        setDiagrams((prev) => {
          const rest = prev.filter((d) => d.id !== currentId);
          setCurrentId(rest[0]?.id ?? null);
          return rest;
        });
      }
      setDialog(null);
    } catch (e) {
      showError(e);
    }
  }, [dialog, currentId, showError]);

  const fieldSx = useMemo(
    () => ({
      minWidth: 190,
      '& .MuiOutlinedInput-root': {
        background: t.paper, ...CARD_HOVER_SX,
        color: t.ink,
        fontWeight: 600,
        fontSize: '0.85rem',
        '& fieldset': { borderColor: t.line },
        '&:hover fieldset': { borderColor: t.rust },
        '&.Mui-focused fieldset': { borderColor: t.rust },
      },
    }),
    [t],
  );

  const diagramControls = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
      {diagrams.length > 0 && (
        <TextField
          select
          size="small"
          value={currentId ?? ''}
          onChange={(e) => setCurrentId(Number(e.target.value))}
          sx={fieldSx}
        >
          {diagrams.map((d) => (
            <MenuItem key={d.id} value={d.id}>
              {d.name}
            </MenuItem>
          ))}
        </TextField>
      )}
      {!readOnly && (
        <Tooltip title="New diagram">
          <IconButton
            size="small"
            onClick={() => setDialog({ mode: 'create', value: '' })}
            sx={{ color: t.rust, border: `1px solid ${t.line}` }}
          >
            <NewIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {currentDiagram && !readOnly && (
        <>
          <Tooltip title="Rename diagram">
            <IconButton
              size="small"
              onClick={() => setDialog({ mode: 'rename', value: currentDiagram.name })}
              sx={{ color: t.muted, border: `1px solid ${t.line}` }}
            >
              <RenameIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Duplicate diagram">
            <IconButton
              size="small"
              onClick={() => setDialog({ mode: 'duplicate', value: `${currentDiagram.name} (copy)` })}
              sx={{ color: t.muted, border: `1px solid ${t.line}` }}
            >
              <DuplicateIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete diagram">
            <IconButton
              size="small"
              onClick={() => setDialog({ mode: 'delete' })}
              sx={{ color: t.muted, border: `1px solid ${t.line}` }}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Undo (⌘Z)">
            <span>
              <IconButton
                size="small"
                disabled={!canUndo}
                onClick={undo}
                sx={{ color: t.muted, border: `1px solid ${t.line}` }}
              >
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Redo (⇧⌘Z)">
            <span>
              <IconButton
                size="small"
                disabled={!canRedo}
                onClick={redo}
                sx={{ color: t.muted, border: `1px solid ${t.line}` }}
              >
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </>
      )}
    </Box>
  );

  return (
    <Box sx={pageShellSx(true)}>
      <PageHero
        eyebrow="Power Topology"
        title="Map your power topology"
        accentPhrase="topology"
        subtitle="Chart how everything is powered — devices, power strips, UPSes and wall outlets — then draw the cables between them. Drag a plug onto a device's power-in to connect it."
        actions={diagramControls}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
          <CircularProgress size={30} sx={{ color: t.rust }} />
        </Box>
      ) : diagrams.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            py: 10,
            textAlign: 'center',
          }}
        >
          <Scrim>
            <Typography sx={{ color: t.inkSoft, fontSize: '1rem' }}>
              {readOnly
                ? 'No diagrams yet. You have view-only access, so ask an administrator to add one.'
                : 'No diagrams yet. Create one to start mapping your power layout.'}
            </Typography>
          </Scrim>
          {!readOnly && (
            <Button
              variant="contained"
              startIcon={<NewIcon />}
              onClick={() => setDialog({ mode: 'create', value: 'Office' })}
              sx={{
                textTransform: 'none',
                fontWeight: 700,
                background: t.rust,
                '&:hover': { background: t.rustDark },
              }}
            >
              New diagram
            </Button>
          )}
        </Box>
      ) : (
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            gap: 2,
            alignItems: 'flex-start',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{
                fontFamily: 'var(--hearth-heading)',
                fontWeight: 800,
                fontSize: { xs: '1.5rem', md: '1.9rem' },
                color: t.ink,
                letterSpacing: '-0.01em',
                lineHeight: 1.1,
                mb: 1.25,
              }}
            >
              {currentDiagram?.name}
            </Typography>
            <TopologyCanvas
              items={items}
              connections={connections}
              zones={zones}
              liveUps={liveUps}
              diagramName={currentDiagram?.name ?? 'topology'}
              onCreateConnection={handleCreateConnection}
              onReconnectConnection={handleReconnectConnection}
              onDeleteConnection={handleDeleteConnection}
              onEditConnection={(c) =>
                setConnDialog({ id: c.id, label: c.label ?? '', color: c.color ?? '' })
              }
              onMoveItem={handleMoveItem}
              onBulkMove={handleBulkMove}
              onDeleteItem={handleDeleteItem}
              onDuplicateItem={handleDuplicateItem}
              onSelectItem={setSelected}
              selectedItemId={selected?.id ?? null}
              onCreateZone={handleCreateZone}
              onZoneChange={handleZoneChange}
              onRenameZone={(z) => setZoneDialog({ id: z.id, value: z.name })}
              onDeleteZone={handleDeleteZone}
              readOnly={readOnly}
            />
          </Box>

          <Box sx={{ width: { xs: '100%', md: 320 }, flexShrink: 0 }}>
            <ItemForm
              selected={selected}
              onCreate={handleCreateItem}
              onUpdate={handleUpdateItem}
              onDelete={handleDeleteItem}
              onClearSelection={() => setSelected(null)}
              readOnly={readOnly}
            />
          </Box>
        </Box>
      )}

      {/* Diagram create / rename / delete dialog */}
      <Dialog open={dialog !== null} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
        {dialog?.mode === 'delete' ? (
          <>
            <DialogTitle>Delete diagram?</DialogTitle>
            <DialogContent>
              <Typography sx={{ fontSize: '0.9rem' }}>
                “{currentDiagram?.name}” and all of its items and cables will be permanently
                removed. This cannot be undone.
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDialog(null)} sx={{ textTransform: 'none' }}>
                Cancel
              </Button>
              <Button
                onClick={submitDialog}
                color="error"
                variant="contained"
                sx={{ textTransform: 'none', fontWeight: 700 }}
              >
                Delete
              </Button>
            </DialogActions>
          </>
        ) : (
          dialog && (
            <>
              <DialogTitle>
                {dialog.mode === 'create'
                  ? 'New diagram'
                  : dialog.mode === 'duplicate'
                    ? 'Duplicate diagram'
                    : 'Rename diagram'}
              </DialogTitle>
              <DialogContent>
                <TextField
                  autoFocus
                  fullWidth
                  size="small"
                  label="Name"
                  value={dialog.value}
                  onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitDialog();
                  }}
                  placeholder="Office"
                  sx={{ mt: 1 }}
                />
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setDialog(null)} sx={{ textTransform: 'none' }}>
                  Cancel
                </Button>
                <Button
                  onClick={submitDialog}
                  variant="contained"
                  disabled={!dialog.value.trim()}
                  sx={{
                    textTransform: 'none',
                    fontWeight: 700,
                    background: t.rust,
                    '&:hover': { background: t.rustDark },
                  }}
                >
                  {dialog.mode === 'create' ? 'Create' : dialog.mode === 'duplicate' ? 'Duplicate' : 'Save'}
                </Button>
              </DialogActions>
            </>
          )
        )}
      </Dialog>

      {/* Cable label + circuit color dialog */}
      <Dialog open={connDialog !== null} onClose={() => setConnDialog(null)} maxWidth="xs" fullWidth>
        {connDialog && (
          <>
            <DialogTitle>Edit cable</DialogTitle>
            <DialogContent>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Label"
                value={connDialog.label}
                onChange={(e) => setConnDialog({ ...connDialog, label: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitConnEdit();
                }}
                placeholder="6 ft C13"
                sx={{ mt: 1, mb: 2 }}
              />
              <Typography sx={{ fontSize: '0.75rem', color: t.muted, mb: 1 }}>Circuit color</Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {CIRCUIT_COLORS.map((c) => (
                  <Box
                    key={c}
                    onClick={() => setConnDialog({ ...connDialog, color: c })}
                    sx={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: c,
                      cursor: 'pointer',
                      border: connDialog.color === c ? `3px solid ${t.ink}` : `2px solid ${t.line}`,
                    }}
                  />
                ))}
                <Box
                  onClick={() => setConnDialog({ ...connDialog, color: '' })}
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    color: t.muted,
                    fontSize: '0.7rem',
                    border: connDialog.color === '' ? `3px solid ${t.ink}` : `2px solid ${t.line}`,
                  }}
                >
                  ✕
                </Box>
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConnDialog(null)} sx={{ textTransform: 'none' }}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={submitConnEdit}
                sx={{ textTransform: 'none', fontWeight: 700, background: t.rust, '&:hover': { background: t.rustDark } }}
              >
                Save
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* Zone rename dialog */}
      <Dialog open={zoneDialog !== null} onClose={() => setZoneDialog(null)} maxWidth="xs" fullWidth>
        {zoneDialog && (
          <>
            <DialogTitle>Rename zone</DialogTitle>
            <DialogContent>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Name"
                value={zoneDialog.value}
                onChange={(e) => setZoneDialog({ ...zoneDialog, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitZoneRename();
                }}
                sx={{ mt: 1 }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setZoneDialog(null)} sx={{ textTransform: 'none' }}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={submitZoneRename}
                disabled={!zoneDialog.value.trim()}
                sx={{ textTransform: 'none', fontWeight: 700, background: t.rust, '&:hover': { background: t.rustDark } }}
              >
                Save
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar
        open={error !== null}
        autoHideDuration={5000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" variant="filled" onClose={() => setError(null)} sx={{ fontSize: '0.85rem' }}>
          {error}
        </Alert>
      </Snackbar>
    </Box>
  );
}
