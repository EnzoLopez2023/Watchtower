// Custom React Flow node for a power-topology item.
//
// Handles map to real-world power connectors:
//   • a single "power-in" TARGET handle on top (unless it's a wall outlet). It
//     turns green when something powers this item.
//   • one SOURCE handle per output plug along the bottom (UPS / power strip /
//     outlet). A plug is amber when free and green when a device is plugged in,
//     and its label shows the connected device's name.
//
// Drag from a plug (source) to a device's power-in (target) to draw a cable.
// Drag an existing cable's endpoint to move it, or off the canvas to unplug.

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Box, Tooltip, Typography } from '@mui/material';
import {
  StickyNote2 as NoteIcon,
  WarningAmber as WarnIcon,
  BatteryChargingFull as BatteryIcon,
} from '@mui/icons-material';
import { useThemeMode } from '../../context/ThemeContext';
import { tokensFor } from '../../theme/tokens';
import { KIND_META, plugLabel, plugTypeFor, type LiveUps, type PowerItem } from '../types';
import type { PowerState } from '../analysis';
import { optionForItem } from '../typeMeta';

export type ItemNodeData = {
  item: PowerItem;
  /** Per-plug connected device name (index = plug); null = free plug. */
  plugTargets: (string | null)[];
  /** True when this item is powered by an incoming cable. */
  isPowered: boolean;
  /** Provider only: summed downstream device watts. */
  load: number | null;
  /** Provider capacity exceeded by load. */
  overloaded: boolean;
  /** Outage view state, or null when the outage view is off. */
  powerState: PowerState | null;
  /** Live UPS snapshot when this UPS is linked to the Power Monitor. */
  liveUps: LiveUps | null;
};
export type ItemNodeType = Node<ItemNodeData, 'item'>;

export default function ItemNode({ data, selected }: NodeProps<ItemNodeType>) {
  const { item, plugTargets, isPowered, load, overloaded, powerState, liveUps } = data;
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');

  const meta = KIND_META[item.kind];
  const option = optionForItem(item);
  const Icon = option.Icon;
  const plugs = meta.providesPlugs ? Math.max(0, item.plug_count) : 0;
  const minWidth = Math.max(190, plugs * 52);

  const green = isDark ? '#43C97D' : '#2E9E5B';
  const red = isDark ? '#F0776E' : '#C4443A';

  // Power sources (outlet / UPS / power strip) get a subtle amber wash + accent
  // border so they read as the roots of the diagram; consumers stay neutral.
  const isSource = meta.providesPlugs;
  let bg = isSource ? `linear-gradient(0deg, ${t.rust}22, ${t.rust}22), ${t.paper}` : t.paper;
  let restingBorder = isSource ? `${t.rust}80` : t.line;
  let glow = isSource ? `0 4px 16px ${t.rust}33` : '0 4px 14px rgba(0,0,0,0.14)';

  // Outage view recolors every node by whether it survives a power cut.
  if (powerState) {
    // 'unknown' gets its own amber tone rather than the neutral resting style:
    // "we have not recorded which UPS bank this is on" is a state worth acting
    // on, and rendering it as plain paper made it read as "nothing to see".
    const amber = isDark ? '#E6A63A' : '#B8860B';
    const tone = powerState === 'protected' ? green
      : powerState === 'exposed' ? red
      : amber;
    bg = `linear-gradient(0deg, ${tone}22, ${tone}22), ${t.paper}`;
    restingBorder = tone;
    glow = `0 4px 16px ${tone}33`;
  }

  // Watts summary: draw for a consumer, load (/ capacity) for a provider.
  let wattsText = '';
  if (isSource) {
    const cap = item.watts;
    if ((load ?? 0) > 0 || cap != null) wattsText = cap != null ? `${load ?? 0} / ${cap} W` : `${load ?? 0} W`;
  } else if (item.watts != null) {
    wattsText = `${item.watts} W`;
  }

  const baseDot = {
    width: 13,
    height: 13,
    borderRadius: '50%',
    border: `2px solid ${t.paper}`,
    boxShadow: `0 0 0 1px ${t.line}`,
  } as const;

  return (
    <Box
      sx={{
        position: 'relative',
        minWidth,
        maxWidth: 380,
        background: bg,
        border: `1.5px solid ${selected ? t.rust : restingBorder}`,
        borderRadius: 2,
        boxShadow: selected ? `0 0 0 3px ${t.rust}33, 0 6px 18px rgba(0,0,0,0.18)` : glow,
        px: 1.5,
        pt: 1.25,
        pb: plugs > 0 ? 0.5 : 1.25,
        transition: 'border-color 120ms, box-shadow 120ms',
      }}
    >
      {/* Power-in (target) — green once powered. */}
      {meta.acceptsPower && (
        <Handle
          type="target"
          position={Position.Top}
          id="in"
          style={{
            width: 13,
            height: 13,
            background: isPowered ? green : t.champagne,
            border: `2px solid ${t.paper}`,
            boxShadow: `0 0 0 1px ${t.line}`,
            top: -7,
          }}
        />
      )}

      {/* Notes indicator */}
      {item.notes && (
        <Tooltip title={item.notes} arrow>
          <Box sx={{ position: 'absolute', top: 4, right: 4, color: t.muted, display: 'flex' }}>
            <NoteIcon sx={{ fontSize: 15 }} />
          </Box>
        </Tooltip>
      )}

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 1.5,
            background: isSource ? `${t.rust}33` : `${t.rust}22`,
            color: t.rust,
            flexShrink: 0,
          }}
        >
          <Icon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ minWidth: 0, pr: item.notes ? 2 : 0 }}>
          <Typography
            sx={{
              fontWeight: 700,
              fontSize: '0.86rem',
              color: t.ink,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: '0.68rem', color: t.muted, lineHeight: 1.2 }}>
              {option.label}
              {plugs > 0 ? ` · ${plugs} plug${plugs === 1 ? '' : 's'}` : ''}
              {wattsText ? ` · ` : ''}
            </Typography>
            {wattsText && (
              <Typography
                sx={{ fontSize: '0.68rem', lineHeight: 1.2, fontWeight: 700, color: overloaded ? red : t.inkSoft, display: 'flex', alignItems: 'center', gap: 0.25 }}
              >
                {overloaded && <WarnIcon sx={{ fontSize: 13 }} />}
                {wattsText}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      {/* Live UPS readout (linked to the Power Monitor feed) */}
      {(liveUps || (item.kind === 'ups' && Boolean(item.link_live))) && (
        <Box
          sx={{
            mt: 0.75,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 0.75,
            py: 0.4,
            borderRadius: 1,
            background: `${t.rust}18`,
            border: `1px solid ${t.line}`,
          }}
        >
          <BatteryIcon sx={{ fontSize: 14, color: !liveUps || liveUps.stale ? t.muted : green }} />
          <Typography sx={{ fontSize: '0.66rem', color: t.inkSoft, fontWeight: 600 }}>
            {liveUps
              // Name the unit. With more than one UPS these figures are
              // otherwise unattributable, and a node bound to the wrong one
              // looks entirely plausible.
              ? `${liveUps.label} · ${liveUps.battery_charge ?? '—'}% · ${liveUps.ups_status ?? '—'}${liveUps.ups_load != null ? ` · ${liveUps.ups_load}% load` : ''}${liveUps.stale ? ' · stale' : ''}`
              : item.ups_id
                ? `No live data for "${item.ups_id}"`
                : 'Pick which UPS to mirror'}
          </Typography>
        </Box>
      )}

      {/* Bank header — only a UPS has two banks, and the physical outlets look
          identical, so the split is spelled out rather than implied. */}
      {plugs > 0 && item.kind === 'ups' && (() => {
        const half = Math.ceil(plugs / 2);
        const amber = isDark ? '#E6A63A' : '#B8860B';
        const band = (label: string, span: number, colour: string) => (
          <Box sx={{
            flex: span, minWidth: 0, px: 0.25, py: '1px',
            bgcolor: `${colour}22`, border: `1px solid ${colour}66`, borderRadius: '4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Typography sx={{
              fontSize: '0.5rem', fontWeight: 800, letterSpacing: '0.06em',
              color: colour, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip',
            }}>
              {label}
            </Typography>
          </Box>
        );
        return (
          <Box sx={{ display: 'flex', gap: 0.4, mt: 0.75 }}>
            {band('BATTERY', half, green)}
            {plugs - half > 0 && band('SURGE ONLY', plugs - half, amber)}
          </Box>
        );
      })()}

      {/* Plug strip (source handles laid out in-flow beneath their labels). */}
      {plugs > 0 && (
        <Box sx={{ display: 'flex', mt: 0.5 }}>
          {Array.from({ length: plugs }).map((_, i) => {
            const connectedName = plugTargets[i] ?? null;
            const label = connectedName ?? plugLabel(item, i);
            // Derived from position: first half battery, second half surge.
            const plugType = plugTypeFor(item, i);
            const surge = plugType === 'surge';
            const dotColour = surge
              ? (isDark ? '#E6A63A' : '#B8860B')
              : connectedName ? green : t.rust;
            return (
              <Box
                key={i}
                sx={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 0.5,
                  minWidth: 0,
                  px: 0.25,
                }}
              >
                <Typography
                  sx={{
                    fontSize: '0.58rem',
                    color: connectedName ? (surge ? dotColour : green) : t.muted,
                    fontWeight: connectedName ? 700 : 400,
                    lineHeight: 1.1,
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '100%',
                  }}
                  title={plugType ? `${label} — ${surge ? 'surge only, no battery' : 'battery backed'}` : `${label} — protection not set`}
                >
                  {label}
                </Typography>
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id={`plug-${i}`}
                  style={{
                    position: 'relative',
                    transform: 'none',
                    left: 0,
                    bottom: 0,
                    margin: '0 auto',
                    background: dotColour,
                    // A hollow centre marks surge-only, so the two banks are
                    // distinguishable without relying on colour alone.
                    ...baseDot,
                    ...(surge ? { boxShadow: `inset 0 0 0 2px ${t.paper}` } : {}),
                  }}
                />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
