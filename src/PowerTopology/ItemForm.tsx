// Create / edit form for a power-topology item.
//
// In "create" mode it adds a new item (auto-placed on the canvas by the parent).
// When a node is selected on the canvas the form switches to "edit" mode for
// that item — the structural kind is locked (only device sub-categories can be
// changed) because changing kind would invalidate any cables already attached.

import { apiFetch } from '../services/apiClient';
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  ListSubheader,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  AddCircleOutline as AddIcon,
  Save as SaveIcon,
  DeleteOutline as DeleteIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { tokensFor } from '../theme/tokens';
import { useThemeMode } from '../context/ThemeContext';
import type { CreateItemPayload, UpdateItemPayload } from './api';
import { KIND_META, type LiveUpsEnvelope, type PowerItem } from './types';
import { TYPE_OPTIONS, optionByValue, optionForItem, type TypeGroup } from './typeMeta';
import { CARD_HOVER_SX } from '../theme/controls';

interface ItemFormProps {
  selected: PowerItem | null;
  onCreate: (payload: Omit<CreateItemPayload, 'diagram_id'>) => void;
  onUpdate: (id: number, payload: UpdateItemPayload) => void;
  onDelete: (id: number) => void;
  onClearSelection: () => void;
  /** View-only: the panel becomes a detail card for the selected item. */
  readOnly: boolean;
}

const MAX_PLUGS = 24;
const GROUPS: TypeGroup[] = ['Devices', 'Power sources'];

export default function ItemForm({
  selected,
  onCreate,
  onUpdate,
  onDelete,
  onClearSelection,
  readOnly,
}: ItemFormProps) {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');

  const editing = selected !== null;

  const [name, setName] = useState('');
  const [typeValue, setTypeValue] = useState('device');
  const [plugCount, setPlugCount] = useState(0);
  const [plugLabels, setPlugLabels] = useState<string[]>([]);
  const [watts, setWatts] = useState('');
  const [linkLive, setLinkLive] = useState(false);
  const [upsId, setUpsId] = useState('');
  const [units, setUnits] = useState<LiveUpsEnvelope[]>([]);
  const [notes, setNotes] = useState('');

  // The real units currently reporting, so the picker offers what exists
  // rather than asking the user to type an agent-defined id.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/ups')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && Array.isArray(j?.upses)) setUnits(j.upses);
      })
      .catch(() => { /* picker just stays empty */ });
    return () => { cancelled = true; };
  }, []);

  // Sync form state whenever the selection changes (or clears → reset).
  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setTypeValue(optionForItem(selected).value);
      setPlugCount(selected.plug_count);
      setPlugLabels(
        Array.from({ length: selected.plug_count }, (_, i) => selected.plug_labels?.[i] ?? ''),
      );
      setWatts(selected.watts != null ? String(selected.watts) : '');
      setLinkLive(Boolean(selected.link_live));
      setUpsId(selected.ups_id ?? '');
      setNotes(selected.notes ?? '');
    } else {
      setName('');
      setTypeValue('device');
      setPlugCount(0);
      setPlugLabels([]);
      setWatts('');
      setLinkLive(false);
      setUpsId('');
      setNotes('');
    }
  }, [selected]);

  const option = optionByValue(typeValue);
  const meta = KIND_META[option.kind];

  // In edit mode the structural kind is fixed — only offer options of that kind
  // (all device sub-categories, or the single matching power source).
  const visibleOptions = editing && selected
    ? TYPE_OPTIONS.filter((o) => o.kind === selected.kind)
    : TYPE_OPTIONS;

  // When switching type, seed a sensible default plug count for providers.
  const handleTypeChange = (next: string) => {
    const opt = optionByValue(next);
    setTypeValue(next);
    setPlugCount(opt.defaultPlugs);
    setPlugLabels(Array.from({ length: opt.defaultPlugs }, () => ''));
  };

  const handlePlugCountChange = (raw: string) => {
    const n = Math.max(1, Math.min(MAX_PLUGS, Math.floor(Number(raw) || 1)));
    setPlugCount(n);
    setPlugLabels((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ''));
  };

  const setLabelAt = (i: number, value: string) => {
    setPlugLabels((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  const labelsPayload = () =>
    option.providesPlugs ? plugLabels.map((l) => (l.trim() ? l.trim() : null)) : undefined;

  const canSubmit = name.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const trimmedWatts = watts.trim();
    const base = {
      name: name.trim(),
      subtype: option.subtype,
      plug_count: option.providesPlugs ? plugCount : 0,
      plug_labels: labelsPayload(),
      watts: trimmedWatts === '' ? null : Math.max(0, Math.round(Number(trimmedWatts) || 0)),
      link_live: option.kind === 'ups' ? linkLive : false,
      ups_id: option.kind === 'ups' && linkLive ? (upsId || null) : null,
      notes: notes.trim() ? notes.trim() : null,
    };
    if (editing && selected) {
      onUpdate(selected.id, base);
    } else {
      onCreate({ kind: option.kind, ...base });
    }
  };

  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      background: t.paper, ...CARD_HOVER_SX,
      color: t.ink,
      fontSize: '0.85rem',
      '& fieldset': { borderColor: t.line },
      '&:hover fieldset': { borderColor: t.rust },
      '&.Mui-focused fieldset': { borderColor: t.rust },
    },
    '& .MuiInputLabel-root': { color: t.muted, fontSize: '0.85rem' },
    '& .MuiInputLabel-root.Mui-focused': { color: t.rust },
  } as const;

  return (
    <Box
      sx={{
        background: t.surface,
        border: `1px solid ${t.line}`,
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', color: t.ink }}>
          {readOnly ? (editing ? 'Item details' : 'Items') : editing ? 'Edit item' : 'Add item'}
        </Typography>
        {editing && !readOnly && (
          <Button
            size="small"
            startIcon={<CloseIcon sx={{ fontSize: 16 }} />}
            onClick={onClearSelection}
            sx={{ color: t.muted, textTransform: 'none', minWidth: 0 }}
          >
            New
          </Button>
        )}
      </Box>

      {readOnly && !editing && (
        <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
          Select an item on the canvas to see its details.
        </Typography>
      )}

      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        size="small"
        fullWidth
        disabled={readOnly}
        placeholder="Synology NAS"
        sx={fieldSx}
      />

      <TextField
        select
        label="Type"
        value={typeValue}
        onChange={(e) => handleTypeChange(e.target.value)}
        size="small"
        fullWidth
        disabled={readOnly}
        helperText={meta.hint}
        sx={{
          ...fieldSx,
          '& .MuiFormHelperText-root': { color: t.muted, fontSize: '0.68rem', mx: 0 },
        }}
      >
        {GROUPS.flatMap((group) => {
          const opts = visibleOptions.filter((o) => o.group === group);
          if (opts.length === 0) return [];
          return [
            <ListSubheader key={group} sx={{ background: t.surface, color: t.muted, fontSize: '0.7rem', lineHeight: 2 }}>
              {group}
            </ListSubheader>,
            ...opts.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <o.Icon sx={{ fontSize: 16, color: t.rust }} />
                  {o.label}
                </Box>
              </MenuItem>
            )),
          ];
        })}
      </TextField>

      {option.providesPlugs && (
        <>
          <TextField
            label="Number of plugs"
            type="number"
            value={plugCount}
            onChange={(e) => handlePlugCountChange(e.target.value)}
            size="small"
            fullWidth
            disabled={readOnly}
            inputProps={{ min: 1, max: MAX_PLUGS }}
            sx={fieldSx}
          />

          <Box>
            <Typography sx={{ fontSize: '0.72rem', color: t.muted, mb: 0.75 }}>
              Plug labels (optional)
              {/* A UPS's banks are derived from plug order, so there is nothing
                  to tick here — first half battery, second half surge. */}
              {option.kind === 'ups' && ' · first half is battery-backed, second half surge only'}
            </Typography>
            <Stack spacing={1} sx={{ maxHeight: 220, overflowY: 'auto', pr: 0.5 }}>
              {plugLabels.map((label, i) => {
                const type = option.kind === 'ups'
                  ? (i < Math.ceil(plugCount / 2) ? 'battery' : 'surge')
                  : null;
                const colour = type === 'battery' ? (isDark ? '#43C97D' : '#2E9E5B')
                  : type === 'surge' ? (isDark ? '#E6A63A' : '#B8860B')
                  : t.muted;
                return (
                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    {type && (
                      <Chip
                        size="small"
                        label={type === 'battery' ? 'battery' : 'surge'}
                        sx={{
                          height: 22, minWidth: 62, fontSize: '0.65rem',
                          color: colour, bgcolor: `${colour}1F`, border: `1px solid ${colour}55`,
                        }}
                      />
                    )}
                    <TextField
                      value={label}
                      onChange={(e) => setLabelAt(i, e.target.value)}
                      size="small"
                      fullWidth
                      disabled={readOnly}
                      placeholder={`Plug ${i + 1}`}
                      sx={fieldSx}
                    />
                  </Box>
                );
              })}
            </Stack>
          </Box>
        </>
      )}

      <TextField
        label={option.providesPlugs ? 'Capacity (W, optional)' : 'Power draw (W, optional)'}
        type="number"
        value={watts}
        onChange={(e) => setWatts(e.target.value)}
        size="small"
        fullWidth
        disabled={readOnly}
        inputProps={{ min: 0 }}
        sx={fieldSx}
      />

      {option.kind === 'ups' && (
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={linkLive}
              disabled={readOnly}
              onChange={(e) => setLinkLive(e.target.checked)}
              sx={{ '& .Mui-checked': { color: t.rust }, '& .Mui-checked + .MuiSwitch-track': { backgroundColor: t.rust } }}
            />
          }
          label={
            <Typography sx={{ fontSize: '0.78rem', color: t.inkSoft }}>
              Show live Power Monitor data
            </Typography>
          }
          sx={{ ml: 0 }}
        />
      )}

      {option.kind === 'ups' && linkLive && (
        <TextField
          select
          label="Which UPS"
          value={upsId}
          onChange={(e) => setUpsId(e.target.value)}
          size="small"
          fullWidth
          disabled={readOnly}
          sx={fieldSx}
          helperText={
            units.length > 1
              ? 'Each unit reports separately — pick the one this node represents.'
              : undefined
          }
        >
          {units.length === 0 && <MenuItem value="">No units reporting yet</MenuItem>}
          {units.map((u) => (
            <MenuItem key={u.ups_id} value={u.ups_id}>{u.label ?? u.ups_id}</MenuItem>
          ))}
        </TextField>
      )}

      <TextField
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        size="small"
        fullWidth
        multiline
        minRows={2}
        disabled={readOnly}
        sx={fieldSx}
      />

      {!readOnly && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          <Button
            variant="contained"
            fullWidth
            disabled={!canSubmit}
            startIcon={editing ? <SaveIcon sx={{ fontSize: 18 }} /> : <AddIcon sx={{ fontSize: 18 }} />}
            onClick={handleSubmit}
            sx={{
              textTransform: 'none',
              fontWeight: 700,
              background: t.rust,
              '&:hover': { background: t.rustDark },
            }}
          >
            {editing ? 'Save' : 'Add to canvas'}
          </Button>
          {editing && selected && (
            <Button
              variant="outlined"
              onClick={() => onDelete(selected.id)}
              sx={{
                textTransform: 'none',
                color: t.rust,
                borderColor: t.line,
                minWidth: 0,
                px: 1.5,
                '&:hover': { borderColor: t.rust, background: `${t.rust}11` },
              }}
              aria-label="Delete item"
            >
              <DeleteIcon sx={{ fontSize: 18 }} />
            </Button>
          )}
        </Stack>
      )}
    </Box>
  );
}
