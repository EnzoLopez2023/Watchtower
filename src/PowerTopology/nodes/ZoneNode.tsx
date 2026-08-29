// Background "zone" node — a resizable, draggable labelled rectangle used to
// group items (a rack, desk, closet, room). Rendered behind the item nodes.

import { NodeResizer, type NodeProps, type Node } from '@xyflow/react';
import { Box, Typography } from '@mui/material';
import { useThemeMode } from '../../context/ThemeContext';
import { tokensFor } from '../../theme/tokens';
import type { Zone } from '../types';

export type ZoneNodeData = {
  zone: Zone;
  /** View-only: the zone still shows and selects, but the resize handles go away. */
  readOnly?: boolean;
  onResizeCommit: (patch: { pos_x: number; pos_y: number; width: number; height: number }) => void;
};
export type ZoneNodeType = Node<ZoneNodeData, 'zone'>;

export default function ZoneNode({ data, selected }: NodeProps<ZoneNodeType>) {
  const { zone, readOnly, onResizeCommit } = data;
  const { mode } = useThemeMode();
  const t = tokensFor(mode === 'dark', 'power');
  const color = zone.color || t.rust;

  return (
    <>
      <NodeResizer
        color={color}
        // NodeResizer does not consult the canvas-level `nodesDraggable`, so a
        // view-only user could otherwise still drag a zone bigger.
        isVisible={selected && !readOnly}
        minWidth={100}
        minHeight={80}
        onResizeEnd={(_e, p) =>
          onResizeCommit({ pos_x: p.x, pos_y: p.y, width: p.width, height: p.height })
        }
      />
      <Box
        sx={{
          width: '100%',
          height: '100%',
          borderRadius: 2,
          border: `1.5px dashed ${color}`,
          background: `${color}14`,
          boxSizing: 'border-box',
        }}
      >
        <Typography
          sx={{
            position: 'absolute',
            top: 6,
            left: 10,
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color,
            pointerEvents: 'none',
          }}
        >
          {zone.name}
        </Typography>
      </Box>
    </>
  );
}
