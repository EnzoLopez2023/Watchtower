/**
 * Static, non-interactive reproductions of Watchtower's real screens, used as
 * the "product shots" on the marketing landing page.
 *
 * Every panel is built from the same tokens, radius, chip and stat-card
 * vocabulary the live pages use (src/SystemStatus.tsx, src/AzureCommandCenter
 * .tsx, src/UpsMonitor.tsx, src/UniFiNetwork.tsx, src/Protect.tsx,
 * src/PowerTopology), so the mockups read as genuine captures rather than
 * generic dashboard art. They are decorative: `aria-hidden`, no focus targets,
 * no pointer events.
 */

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import type { HearthTokens } from '../theme/tokens';
import { withAlpha } from '../theme/contrast';
import { IOS_SQUIRCLE, IOS_SQUIRCLE_SM } from '../theme/ios';

type Sev = 'ok' | 'warn' | 'critical' | 'stale';

interface MockProps {
  t: HearthTokens;
  isDark: boolean;
}

function sevColor(t: HearthTokens, isDark: boolean, s: Sev): string {
  if (s === 'ok') return isDark ? '#7f9f6e' : '#5b7a4a';
  if (s === 'warn') return isDark ? '#d9a441' : '#b3801d';
  if (s === 'critical') return isDark ? '#c96442' : '#a8412a';
  return t.muted;
}

/** The frame every mockup panel sits in — shared radius, border and shadow. */
export function MockFrame({
  t,
  isDark,
  title,
  chip,
  children,
  minWidth,
}: MockProps & { title: string; chip?: string; children: ReactNode; minWidth?: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        userSelect: 'none',
        pointerEvents: 'none',
        width: '100%',
        minWidth,
        borderRadius: IOS_SQUIRCLE,
        border: `1px solid ${t.line}`,
        background: `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`,
        boxShadow: isDark
          ? '0 24px 60px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05)'
          : '0 24px 60px -24px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.8)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar with traffic-light dots — reads as an app window. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: `1px solid ${t.line}`,
          background: withAlpha(t.ink, isDark ? 0.04 : 0.02),
        }}
      >
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {['#E5715B', '#E0B23C', '#7f9f6e'].map((c) => (
            <Box key={c} sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: withAlpha(c, 0.9) }} />
          ))}
        </Box>
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: t.inkSoft, letterSpacing: '0.01em' }}>
          {title}
        </Typography>
        {chip && (
          <Typography
            sx={{
              ml: 'auto',
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: t.muted,
            }}
          >
            {chip}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: 1.5 }}>{children}</Box>
    </Box>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        px: 0.75,
        borderRadius: '999px',
        fontSize: '0.62rem',
        fontWeight: 700,
        color,
        bgcolor: withAlpha(color, 0.16),
        border: `1px solid ${withAlpha(color, 0.32)}`,
        whiteSpace: 'nowrap',
        letterSpacing: '0.01em',
      }}
    >
      {label}
    </Box>
  );
}

/** System Status — overall verdict + subsystem rows. Mirrors src/SystemStatus.tsx. */
export function StatusMock({ t, isDark }: MockProps) {
  const rows: { label: string; sev: Sev; headline: string }[] = [
    { label: 'UniFi Network', sev: 'ok', headline: 'WAN up · 24 clients' },
    { label: 'Power & UPS', sev: 'ok', headline: 'battery 100% · 47m runtime' },
    { label: 'Azure', sev: 'ok', headline: '9 web apps running' },
    { label: 'Synology Storage', sev: 'warn', headline: 'volume 1 at 82%' },
    { label: 'UniFi Protect', sev: 'ok', headline: '6 cameras online' },
  ];
  return (
    <MockFrame t={t} isDark={isDark} title="System Status" chip="updated 12s ago">
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          p: 1.25,
          mb: 1,
          borderRadius: IOS_SQUIRCLE_SM,
          border: `1px solid ${withAlpha(sevColor(t, isDark, 'warn'), 0.35)}`,
          bgcolor: withAlpha(sevColor(t, isDark, 'warn'), 0.08),
        }}
      >
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: sevColor(t, isDark, 'warn') }} />
        <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: t.ink }}>
          1 subsystem needs attention
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        {rows.map((r) => (
          <Box
            key={r.label}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1.25,
              py: 0.9,
              borderRadius: IOS_SQUIRCLE_SM,
              border: `1px solid ${t.line}`,
              bgcolor: withAlpha(t.ink, isDark ? 0.03 : 0.015),
            }}
          >
            <Box
              sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: sevColor(t, isDark, r.sev), flexShrink: 0 }}
            />
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 700, color: t.ink }}>{r.label}</Typography>
            <Typography
              sx={{
                ml: 'auto',
                fontSize: '0.68rem',
                color: t.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.headline}
            </Typography>
            <Pill
              label={r.sev === 'ok' ? 'OK' : r.sev === 'warn' ? 'Warning' : 'Critical'}
              color={sevColor(t, isDark, r.sev)}
            />
          </Box>
        ))}
      </Box>
    </MockFrame>
  );
}

function StatCell({
  t,
  label,
  value,
  sub,
  accent,
}: {
  t: HearthTokens;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: IOS_SQUIRCLE_SM,
        border: `1px solid ${t.line}`,
        background: withAlpha(t.ink, 0.02),
      }}
    >
      <Typography
        sx={{
          fontSize: '0.58rem',
          fontWeight: 700,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: t.muted,
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          fontSize: '1.3rem',
          fontWeight: 800,
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          color: accent ?? t.ink,
          fontVariantNumeric: 'tabular-nums',
          // index.css sets `overflow-wrap: anywhere` on the body, which would
          // otherwise break a value like "$438" mid-number.
          overflowWrap: 'normal',
          wordBreak: 'keep-all',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography>
      {sub && (
        <Typography sx={{ fontSize: '0.62rem', color: t.muted, whiteSpace: 'nowrap' }}>{sub}</Typography>
      )}
    </Box>
  );
}

/** Azure "At a glance" stat grid. Mirrors src/AzureCommandCenter.tsx. */
export function GlanceMock({ t, isDark }: MockProps) {
  return (
    <MockFrame t={t} isDark={isDark} title="Azure Command Center" chip="at a glance">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.75 }}>
        <StatCell t={t} label="Resource groups" value="14" />
        <StatCell t={t} label="Resources" value="212" />
        <StatCell t={t} label="Web apps" value="9" sub="7 running" accent={sevColor(t, isDark, 'ok')} />
        <StatCell t={t} label="ACR registries" value="3" />
        <StatCell t={t} label="MTD spend" value="$438" />
        <StatCell t={t} label="Projected" value="$612" sub="this cycle" />
      </Box>
    </MockFrame>
  );
}

/** UPS gauges. Mirrors src/UpsMonitor.tsx StatCard row. */
export function PowerMock({ t, isDark }: MockProps) {
  return (
    <MockFrame t={t} isDark={isDark} title="Power & UPS" chip="live · agent push">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0.75 }}>
        <StatCell t={t} label="Battery" value="100%" accent={sevColor(t, isDark, 'ok')} />
        <StatCell t={t} label="Runtime" value="47m" sub="at current load" />
        <StatCell t={t} label="Load" value="18%" />
        <StatCell t={t} label="Input" value="122 V" sub="mains" />
      </Box>
    </MockFrame>
  );
}

/** UniFi WAN summary + throughput sparkline. Mirrors src/UniFiNetwork.tsx. */
export function NetworkMock({ t, isDark }: MockProps) {
  const spark = [8, 10, 7, 14, 9, 22, 12, 16, 11, 9, 13, 8, 10, 7, 6, 12];
  const max = Math.max(...spark);
  return (
    <MockFrame t={t} isDark={isDark} title="UniFi Network" chip="last 24h">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0.75, mb: 1 }}>
        <StatCell t={t} label="WAN latency" value="8 ms" accent={sevColor(t, isDark, 'ok')} />
        <StatCell t={t} label="WAN uptime" value="21d" />
        <StatCell t={t} label="Down / Up" value="940 / 42" sub="Mbps" />
        <StatCell t={t} label="Devices" value="24 / 24" sub="online" />
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0.5,
          height: 44,
          px: 1,
          py: 0.75,
          borderRadius: IOS_SQUIRCLE_SM,
          border: `1px solid ${t.line}`,
          background: withAlpha(t.ink, 0.02),
        }}
      >
        {spark.map((v, i) => (
          <Box
            key={i}
            sx={{
              flex: 1,
              height: `${(v / max) * 100}%`,
              borderRadius: '2px',
              bgcolor: withAlpha(t.rust, 0.55 + (v / max) * 0.4),
            }}
          />
        ))}
      </Box>
    </MockFrame>
  );
}

/**
 * Power / network topology — zones, item nodes and the edges between them.
 * Mirrors the flow of src/PowerTopology / src/UniFiTopology.
 */
export function TopologyMock({ t, isDark }: MockProps) {
  const node = (x: number, y: number, label: string, sub: string, accent?: string) => (
    <g transform={`translate(${x} ${y})`}>
      <rect
        width={116}
        height={44}
        rx={12}
        fill={t.paper}
        stroke={accent ?? t.line}
        strokeWidth={accent ? 1.5 : 1}
      />
      <text x={10} y={18} fontSize={10} fontWeight={700} fill={t.ink}>
        {label}
      </text>
      <text x={10} y={32} fontSize={8.5} fill={t.muted}>
        {sub}
      </text>
    </g>
  );
  const wire = (d: string) => (
    <path d={d} fill="none" stroke={withAlpha(t.rust, 0.5)} strokeWidth={1.5} strokeLinecap="round" />
  );
  return (
    <MockFrame t={t} isDark={isDark} title="Power Topology" chip="single-line">
      <Box
        sx={{
          borderRadius: IOS_SQUIRCLE_SM,
          border: `1px solid ${t.line}`,
          background: withAlpha(t.ink, 0.02),
          overflow: 'hidden',
        }}
      >
        <svg viewBox="0 0 380 240" width="100%" role="presentation">
          {/* faint grid */}
          {Array.from({ length: 8 }).map((_, i) => (
            <line
              key={`v${i}`}
              x1={i * 48 + 8}
              y1={8}
              x2={i * 48 + 8}
              y2={232}
              stroke={withAlpha(t.line, 0.6)}
              strokeWidth={0.5}
            />
          ))}
          {Array.from({ length: 5 }).map((_, i) => (
            <line
              key={`h${i}`}
              x1={8}
              y1={i * 48 + 16}
              x2={372}
              y2={i * 48 + 16}
              stroke={withAlpha(t.line, 0.6)}
              strokeWidth={0.5}
            />
          ))}
          {wire('M 74 52 L 74 96')}
          {wire('M 74 140 L 74 184')}
          {wire('M 132 118 L 200 118')}
          {wire('M 258 96 L 258 118 L 200 118')}
          {node(16, 8, 'Utility meter', '240 V · 1-phase')}
          {node(16, 96, 'CyberPower UPS', 'load 18% · OK', sevColor(t, isDark, 'ok'))}
          {node(16, 184, 'Server rack', '4 devices')}
          {node(200, 96, 'PoE switch', '8 ports · 41 W')}
          {node(200, 184, 'Synology NAS', 'on UPS', sevColor(t, isDark, 'ok'))}
        </svg>
      </Box>
    </MockFrame>
  );
}

/** UniFi Protect camera strip. Mirrors src/Protect.tsx. */
export function ProtectMock({ t, isDark }: MockProps) {
  const cams = ['Front door', 'Driveway', 'Garage', 'Back yard', 'Side gate', 'Porch'];
  return (
    <MockFrame t={t} isDark={isDark} title="UniFi Protect" chip="6 cameras">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.75, mb: 1 }}>
        <StatCell t={t} label="Cameras" value="6" />
        <StatCell t={t} label="Online" value="6" accent={sevColor(t, isDark, 'ok')} />
        <StatCell t={t} label="Smart detect" value="4" accent={t.champagne} />
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.75 }}>
        {cams.map((c) => (
          <Box
            key={c}
            sx={{
              aspectRatio: '16 / 10',
              borderRadius: IOS_SQUIRCLE_SM,
              border: `1px solid ${t.line}`,
              background: `linear-gradient(135deg, ${withAlpha(t.ink, 0.06)} 0%, ${withAlpha(
                t.rust,
                0.12,
              )} 100%)`,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                position: 'absolute',
                top: 4,
                left: 4,
                width: 5,
                height: 5,
                borderRadius: '50%',
                bgcolor: sevColor(t, isDark, 'ok'),
                boxShadow: `0 0 6px ${sevColor(t, isDark, 'ok')}`,
              }}
            />
            <Typography
              sx={{
                position: 'absolute',
                bottom: 3,
                left: 5,
                right: 5,
                fontSize: '0.56rem',
                fontWeight: 600,
                color: t.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c}
            </Typography>
          </Box>
        ))}
      </Box>
    </MockFrame>
  );
}
