// Network Configuration — how the network is *set up*, as opposed to how it is
// currently behaving (which is the UniFi Network page's job).
//
// Everything here comes from the Network Integration API via the local agent,
// refreshed on a slow cadence because it changes on the order of weeks. The
// value is in the joins: an SSID with zero clients or a VLAN nothing sits on is
// the interesting case, and neither is visible from the config alone.
//
// Credentials (WPA passphrases, RADIUS secrets) are stripped agent-side before
// storage, so they never reach this page.
import { apiFetch } from './services/apiClient';
import { pageShellSx } from './theme/controls';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Box, Typography, Chip, CircularProgress, Tooltip, LinearProgress,
} from '@mui/material';
import { motion } from 'framer-motion';
import {
  Wifi as WifiIcon,
  WifiOff as WifiOffIcon,
  Lan as VlanIcon,
  Security as FirewallIcon,
  Dns as DnsIcon,
  VpnLock as VpnIcon,
  Hub as SwitchingIcon,
  NewReleases as PendingIcon,
  Lock as LockIcon,
  LockOpen as OpenLockIcon,
  VisibilityOff as HiddenIcon,
  Schedule as ScheduleIcon,
  Block as BlockIcon,
  Router as WanIcon,
  CompareArrows as ForwardIcon,
  SignalCellularAlt as CellIcon,
  Label as TagIcon,
  Groups as ClientsIcon,
  Shield as ShieldIcon,
} from '@mui/icons-material';
import PageHero from './components/PageHero';
import Scrim from './components/Scrim';
import { useThemeMode } from './context/ThemeContext';
import { tokensFor } from './theme/tokens';

type Tk = ReturnType<typeof tokensFor>;

interface Wifi {
  id: string; name: string; enabled: boolean; type: string | null;
  security: string; hidden: boolean; client_isolation: boolean;
  network_name: string | null; mac_filter_action: string | null; mac_filter_count: number;
  scheduled_off: boolean; client_count: number;
}
interface Network {
  id: string; name: string; vlan_id: number | null; enabled: boolean; is_default: boolean;
  management: string | null; subnet: string | null; gateway_ip: string | null;
  dhcp_mode: string | null; dhcp_start: string | null; dhcp_stop: string | null;
  dhcp_lease_seconds: number | null; dhcp_dns: string[]; domain_name: string | null;
  internet_access: boolean | null; isolation: boolean; mdns: boolean; client_count: number;
}
interface FirewallPolicy {
  id: string; name: string | null; action: string | null; enabled: boolean;
  logging: boolean; source_zone: string | null; destination_zone: string | null; predefined: boolean;
}
interface PortForward {
  id: string; name: string | null; enabled: boolean; proto: string;
  src: string; dst_port: string | null; fwd_ip: string | null; fwd_port: string | null;
  interface: string | null; log: boolean;
}
interface WanHealth {
  wan_ip?: string; isp_name?: string; isp_organization?: string; asn?: string | number;
  gateways?: string[]; nameservers?: string[]; status?: string; gw_name?: string; gw_version?: string;
}
interface Config {
  present?: boolean;
  age_seconds?: number;
  controller_version?: string | null;
  agent_build?: number | null;
  agent_build_for_port_forwards?: number;
  networks?: Network[];
  wifi?: Wifi[];
  port_forwards?: PortForward[];
  wan_health?: WanHealth | null;
  firewall?: { zones: { id: string; name: string; network_ids: string[] }[]; policies: FirewallPolicy[] };
  acls?: { id: string; name: string | null; action: string | null; enabled: boolean }[];
  dns_policies?: { id: string; domain: string | null; type: string | null; enabled: boolean }[];
  vpn?: { servers: { id: string; name: string; type: string | null; enabled: boolean }[]; tunnels: { id: string; name: string; type: string | null }[] };
  switching?: { lags: { id: string; members: number }[]; stacks: { id: string; name: string; members: number }[]; mc_lag_domains: { id: string; name: string }[] };
  pending_devices?: { mac: string; model: string | null; ip: string | null; state: string | null }[];
  device_tags?: { id: string; name: string; device_count: number }[];
  radius_profiles?: { id: string; name: string }[];
  wans?: { id: string; name: string }[];
  traffic_lists?: { id: string; name: string; type: string | null }[];
  voucher_count?: number;
  voucher_active?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const prettify = (s?: string | null): string =>
  (s ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// WPA3 > WPA2 > Open, coloured by how much it should worry you.
const securityRank = (s: string): 0 | 1 | 2 =>
  /OPEN/i.test(s) ? 0 : /WPA3/i.test(s) ? 2 : 1;
const SECURITY_LABEL: Record<string, string> = {
  OPEN: 'Open',
  WPA2_PERSONAL: 'WPA2',
  WPA3_PERSONAL: 'WPA3',
  WPA2_WPA3_PERSONAL: 'WPA2/3',
  WPA2_ENTERPRISE: 'WPA2-Ent',
  WPA3_ENTERPRISE: 'WPA3-Ent',
  WPA2_WPA3_ENTERPRISE: 'WPA2/3-Ent',
};
const securityLabel = (s: string) => SECURITY_LABEL[s] ?? prettify(s);

const fmtLease = (sec?: number | null): string => {
  if (!sec) return '—';
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${Math.round(sec / 60)}m`;
};

// How many addresses a DHCP range spans — the number you actually care about
// when deciding whether a pool is oversized.
const poolSize = (start?: string | null, stop?: string | null): number | null => {
  if (!start || !stop) return null;
  const a = start.split('.').map(Number);
  const b = stop.split('.').map(Number);
  if (a.length !== 4 || b.length !== 4 || a.some(isNaN) || b.some(isNaN)) return null;
  const toInt = (p: number[]) =>
    (((p[0] ?? 0) << 24) >>> 0) + ((p[1] ?? 0) << 16) + ((p[2] ?? 0) << 8) + (p[3] ?? 0);
  const n = toInt(b) - toInt(a) + 1;
  return n > 0 && n < 65536 ? n : null;
};

export default function UniFiConfig() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'network');

  const [cfg, setCfg] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/unifi/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) { setCfg(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const ok = isDark ? '#43C97D' : '#2E9E5B';
  const bad = isDark ? '#E0655A' : '#C4443A';
  const warn = '#E0A24A';
  const cardBg = `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`;

  const wifi = useMemo(() => [...(cfg?.wifi ?? [])].sort((a, b) => b.client_count - a.client_count), [cfg]);
  const networks = useMemo(
    () => [...(cfg?.networks ?? [])].sort((a, b) => (a.vlan_id ?? 0) - (b.vlan_id ?? 0)),
    [cfg],
  );
  const policies = cfg?.firewall?.policies ?? [];
  const custom = policies.filter((p) => !p.predefined);
  const forwards = cfg?.port_forwards ?? [];
  // An agent older than the build that added port-forward collection reports
  // nothing at all, which is indistinguishable from having no rules. Say which
  // it is rather than leaving an empty list to be misread.
  const outdatedAgent =
    cfg?.agent_build != null &&
    cfg?.agent_build_for_port_forwards != null &&
    cfg.agent_build < cfg.agent_build_for_port_forwards;
  const wanHealth = cfg?.wan_health ?? null;
  // The cellular modem is an adopted device rather than a WAN entry, so it has
  // to be recognised by model — it is the thing that keeps the house online.
  const cellular = useMemo(
    () => (cfg?.wans ?? []).find((w) => /5g|lte|cell/i.test(w.name)) ?? null,
    [cfg],
  );

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        eyebrow="UNIFI"
        title="Network Configuration"
        accentPhrase="Configuration"
        subtitle="How the network is set up — VLANs, Wi-Fi, firewall posture and services — joined with what is actually connected to each."
      />

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress sx={{ color: t.rust }} />
        </Box>
      )}

      {!loading && error && (
        <Box sx={{ textAlign: 'center', py: 8, color: t.muted }}>
          <Scrim>
            <Typography>Couldn’t reach the Watchtower UniFi API ({error}).</Typography>
          </Scrim>
        </Box>
      )}

      {!loading && !error && !cfg?.present && (
        <Box sx={{ textAlign: 'center', py: 10, color: t.muted }}>
          <VlanIcon sx={{ fontSize: 48, opacity: 0.4, mb: 1 }} />
          <Scrim sx={{ display: 'block', mx: 'auto', width: 'fit-content', maxWidth: 540 }}>
            <Typography variant="h6" sx={{ color: t.inkSoft, fontWeight: 600 }}>Waiting for configuration…</Typography>
            <Typography sx={{ mt: 1 }}>
              The UniFi agent reads site configuration on a slower cadence than status.
              It appears here after the next configuration poll.
            </Typography>
          </Scrim>
        </Box>
      )}

      {cfg?.present && (
        <>
          {/* Anything awaiting adoption is the one genuinely actionable thing
              on this page, so it goes first and only when it exists. */}
          {!!cfg.pending_devices?.length && (
            <Box sx={{ mb: 3, p: 2, borderRadius: 2, border: `1px solid ${warn}66`, bgcolor: `${warn}14`, display: 'flex', gap: 1.5 }}>
              <PendingIcon sx={{ color: warn }} />
              <Box>
                <Typography sx={{ fontWeight: 700, color: t.ink }}>
                  {cfg.pending_devices.length} device{cfg.pending_devices.length === 1 ? '' : 's'} awaiting adoption
                </Typography>
                <Typography sx={{ fontSize: '0.8rem', color: t.muted, mt: 0.25 }}>
                  {cfg.pending_devices.map((d) => `${d.model ?? 'Unknown'} (${d.ip ?? d.mac})`).join(' · ')}
                </Typography>
              </Box>
            </Box>
          )}

          {/* ── Wi-Fi ── */}
          <SectionHeading t={t} icon={<WifiIcon />} title="Wi-Fi" caption={`${wifi.length} SSID${wifi.length === 1 ? '' : 's'}`} />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 2 }}>
            {wifi.map((w, i) => (
              <WifiCard key={w.id} w={w} t={t} cardBg={cardBg} ok={ok} bad={bad} warn={warn} index={i} />
            ))}
            {wifi.length === 0 && <EmptyNote t={t} text="No SSIDs reported." />}
          </Box>

          {/* ── Networks / VLANs ── */}
          <SectionHeading t={t} icon={<VlanIcon />} title="Networks & VLANs" caption={`${networks.length} configured`} />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 2 }}>
            {networks.map((n, i) => (
              <NetworkCard key={n.id} n={n} t={t} cardBg={cardBg} ok={ok} warn={warn} index={i} />
            ))}
            {networks.length === 0 && <EmptyNote t={t} text="No networks reported." />}
          </Box>

          {/* ── Internet / WAN ── */}
          <SectionHeading t={t} icon={<WanIcon />} title="Internet" caption={`${(cfg.wans ?? []).length} uplink${(cfg.wans ?? []).length === 1 ? '' : 's'}`} />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 2 }}>
            {/* Primary uplink, from the gateway's own health report */}
            <Box sx={{ p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}`, borderLeft: `3px solid ${wanHealth?.status === 'ok' ? ok : warn}` }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography sx={{ fontWeight: 700, color: t.ink, flex: 1 }}>
                  {cfg.wans?.[0]?.name ?? 'Primary uplink'}
                </Typography>
                <Chip size="small" label={wanHealth?.status === 'ok' ? 'Up' : prettify(wanHealth?.status) || 'Unknown'}
                  sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700, bgcolor: `${wanHealth?.status === 'ok' ? ok : warn}1E`, color: wanHealth?.status === 'ok' ? ok : warn }} />
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 0.4, columnGap: 1.25 }}>
                {wanHealth?.isp_name && <Detail t={t} label="ISP">{wanHealth.isp_name}</Detail>}
                {wanHealth?.wan_ip && <Detail t={t} label="Public IP">{wanHealth.wan_ip}</Detail>}
                {!!wanHealth?.gateways?.length && <Detail t={t} label="Gateway">{wanHealth.gateways[0]}</Detail>}
                {wanHealth?.asn && <Detail t={t} label="ASN">{String(wanHealth.asn)}</Detail>}
                {wanHealth?.gw_version && <Detail t={t} label="Firmware">{wanHealth.gw_version}</Detail>}
              </Box>
            </Box>

            {/* Cellular failover — worth calling out explicitly: it only matters
                on the day the primary drops, which is the day nobody checks. */}
            {cellular && (
              <Box sx={{ p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.champagne}` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <CellIcon sx={{ fontSize: '1.1rem', color: t.champagne }} />
                  <Typography sx={{ fontWeight: 700, color: t.ink, flex: 1 }}>{cellular.name}</Typography>
                  <Chip size="small" label="Failover" sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700, bgcolor: `${t.champagne}1E`, color: t.champagne }} />
                </Box>
                <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
                  Cellular backup uplink. Takes over automatically when the primary WAN fails —
                  its own status is on the UniFi Network page with the rest of the adopted devices.
                </Typography>
              </Box>
            )}

            {/* Any other configured uplinks */}
            {(cfg.wans ?? []).slice(1).filter((w) => w.id !== cellular?.id).map((w) => (
              <Box key={w.id} sx={{ p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}` }}>
                <Typography sx={{ fontWeight: 700, color: t.ink }}>{w.name}</Typography>
                <Typography sx={{ fontSize: '0.78rem', color: t.muted, mt: 0.5 }}>Configured uplink</Typography>
              </Box>
            ))}
          </Box>

          {/* ── Port forwarding ── */}
          <SectionHeading
            t={t} icon={<ForwardIcon />} title="Port forwarding"
            caption={`${forwards.length} rule${forwards.length === 1 ? '' : 's'}${forwards.some((f) => !f.enabled) ? ` · ${forwards.filter((f) => !f.enabled).length} disabled` : ''}`}
          />
          {forwards.length === 0 ? (
            <EmptyNote t={t} text={outdatedAgent
              ? `No port-forward rules reported because the on-site agent is out of date — it reports build ${cfg?.agent_build}, and port forwarding needs build ${cfg?.agent_build_for_port_forwards}. Pull the latest agent on the collector machine and re-run install-task.ps1 (re-run it — do not use Restart-ScheduledTask, which leaves the old process running).`
              : "No port-forward rules reported. This comes from the legacy controller API, so it needs the agent's UniFi username and password."} />
          ) : (
            <Box sx={{ borderRadius: 2, background: cardBg, border: `1px solid ${t.line}`, overflow: 'hidden' }}>
              {forwards.map((f, i) => (
                <Box key={f.id ?? i} sx={{
                  display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1, flexWrap: 'wrap',
                  borderTop: i === 0 ? 'none' : `1px solid ${t.line}`,
                  opacity: f.enabled ? 1 : 0.55,
                }}>
                  <Box sx={{ minWidth: 0, flex: '1 1 150px' }}>
                    <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: t.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name || 'Unnamed rule'}
                    </Typography>
                    {f.src && f.src !== 'any' && (
                      <Typography sx={{ fontSize: '0.68rem', color: warn }}>from {f.src}</Typography>
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontFamily: 'monospace', fontSize: '0.78rem', color: t.inkSoft }}>
                    <span>:{f.dst_port ?? '?'}</span>
                    <Typography sx={{ color: t.muted }}>→</Typography>
                    <span>{f.fwd_ip ?? '?'}:{f.fwd_port ?? f.dst_port ?? '?'}</span>
                  </Box>
                  <Chip size="small" label={(f.proto || '').replace('_', '/').toUpperCase()}
                    sx={{ height: 20, fontSize: '0.62rem', bgcolor: `${t.line}66`, color: t.inkSoft }} />
                  {!f.enabled && <Chip size="small" label="Disabled" sx={{ height: 20, fontSize: '0.62rem', bgcolor: `${t.muted}22`, color: t.muted }} />}
                  {f.log && <Chip size="small" label="Logged" sx={{ height: 20, fontSize: '0.62rem', bgcolor: `${t.rust}1E`, color: t.rust }} />}
                </Box>
              ))}
            </Box>
          )}

          {/* ── Security posture ── */}
          <SectionHeading t={t} icon={<FirewallIcon />} title="Security posture" caption="firewall, ACLs and DNS policy" />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', gap: 1.5 }}>
            <Tile t={t} cardBg={cardBg} label="Firewall zones" value={cfg.firewall?.zones?.length ?? 0} icon={<ShieldIcon />} accent={t.rust} />
            <Tile t={t} cardBg={cardBg} label="Custom rules" value={custom.length} icon={<FirewallIcon />} accent={t.champagne}
              hint={`${policies.length} total including predefined`} />
            <Tile t={t} cardBg={cardBg} label="Rules logging" value={policies.filter((p) => p.logging).length} icon={<FirewallIcon />} accent={t.inkSoft} />
            <Tile t={t} cardBg={cardBg} label="Disabled rules" value={policies.filter((p) => !p.enabled).length} icon={<BlockIcon />}
              accent={policies.some((p) => !p.enabled) ? warn : t.muted} />
            <Tile t={t} cardBg={cardBg} label="ACL rules" value={cfg.acls?.length ?? 0} icon={<BlockIcon />} accent={t.inkSoft} />
            <Tile t={t} cardBg={cardBg} label="DNS policies" value={cfg.dns_policies?.length ?? 0} icon={<DnsIcon />} accent={t.inkSoft} />
          </Box>

          {/* Zones are only meaningful with the networks they contain. */}
          {!!cfg.firewall?.zones?.length && (
            <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {cfg.firewall.zones.map((z) => (
                <Chip
                  key={z.id} size="small"
                  label={`${z.name} · ${z.network_ids.length} network${z.network_ids.length === 1 ? '' : 's'}`}
                  sx={{ bgcolor: `${t.rust}18`, color: t.ink, fontWeight: 600, fontSize: '0.72rem' }}
                />
              ))}
            </Box>
          )}

          {/* ── Services: only render what actually exists ── */}
          {(!!cfg.vpn?.servers?.length || !!cfg.vpn?.tunnels?.length
            || !!cfg.switching?.lags?.length || !!cfg.switching?.stacks?.length
            || !!cfg.wans?.length || !!cfg.device_tags?.length
            || !!cfg.radius_profiles?.length || !!cfg.voucher_count) && (
            <>
              <SectionHeading t={t} icon={<SwitchingIcon />} title="Services" caption="only what is configured" />
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', gap: 1.5 }}>
                {!!cfg.wans?.length && (
                  <Tile t={t} cardBg={cardBg} label="WAN uplinks" value={cfg.wans.length} icon={<WanIcon />} accent={ok}
                    hint={cfg.wans.map((w) => w.name).join(', ')} />
                )}
                {!!cfg.vpn?.servers?.length && (
                  <Tile t={t} cardBg={cardBg} label="VPN servers" value={cfg.vpn.servers.length} icon={<VpnIcon />} accent={t.rust}
                    hint={cfg.vpn.servers.map((v) => `${v.name} (${v.type})`).join(', ')} />
                )}
                {!!cfg.vpn?.tunnels?.length && (
                  <Tile t={t} cardBg={cardBg} label="Site-to-site" value={cfg.vpn.tunnels.length} icon={<VpnIcon />} accent={t.rust} />
                )}
                {!!cfg.switching?.lags?.length && (
                  <Tile t={t} cardBg={cardBg} label="Port aggregations" value={cfg.switching.lags.length} icon={<SwitchingIcon />} accent={t.inkSoft} />
                )}
                {!!cfg.switching?.stacks?.length && (
                  <Tile t={t} cardBg={cardBg} label="Switch stacks" value={cfg.switching.stacks.length} icon={<SwitchingIcon />} accent={t.inkSoft} />
                )}
                {!!cfg.device_tags?.length && (
                  <Tile t={t} cardBg={cardBg} label="Device tags" value={cfg.device_tags.length} icon={<TagIcon />} accent={t.inkSoft}
                    hint={cfg.device_tags.map((d) => `${d.name} (${d.device_count})`).join(', ')} />
                )}
                {!!cfg.radius_profiles?.length && (
                  <Tile t={t} cardBg={cardBg} label="RADIUS profiles" value={cfg.radius_profiles.length} icon={<LockIcon />} accent={t.inkSoft} />
                )}
                {!!cfg.voucher_count && (
                  <Tile t={t} cardBg={cardBg} label="Hotspot vouchers" value={cfg.voucher_active ?? 0} icon={<ClientsIcon />} accent={t.inkSoft}
                    hint={`${cfg.voucher_count} total, ${cfg.voucher_active} active`} />
                )}
              </Box>
            </>
          )}

          <Typography sx={{ mt: 4, fontSize: '0.72rem', color: t.muted, textAlign: 'center' }}>
            {cfg.controller_version && `UniFi Network ${cfg.controller_version} · `}
            configuration read {cfg.age_seconds != null ? `${Math.round(cfg.age_seconds / 60)} min ago` : 'recently'}
            {' · Wi-Fi passphrases and RADIUS secrets are stripped before storage'}
          </Typography>
        </>
      )}
    </Box>
  );
}

// ── Wi-Fi card ───────────────────────────────────────────────────────────────
function WifiCard({ w, t, cardBg, ok, bad, warn, index }: {
  w: Wifi; t: Tk; cardBg: string; ok: string; bad: string; warn: string; index: number;
}) {
  const rank = securityRank(w.security);
  const secColor = rank === 0 ? bad : rank === 2 ? ok : warn;
  const dim = !w.enabled;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.03, 0.3) }}
    >
      <Box sx={{
        p: 2, borderRadius: 2, border: `1px solid ${t.line}`, background: cardBg,
        borderLeft: `3px solid ${dim ? t.muted : secColor}`, opacity: dim ? 0.6 : 1, height: '100%',
      }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
          <Box sx={{ width: 38, height: 38, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${secColor}1E`, color: secColor, flexShrink: 0 }}>
            {w.enabled ? <WifiIcon /> : <WifiOffIcon />}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontWeight: 700, color: t.ink, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.name}>
              {w.name}
            </Typography>
            <Typography sx={{ fontSize: '0.74rem', color: t.muted, mt: 0.25 }}>
              {w.network_name ?? 'default network'}{w.type && w.type !== 'STANDARD' ? ` · ${prettify(w.type)}` : ''}
            </Typography>
          </Box>
          <Chip
            size="small" label={securityLabel(w.security)}
            icon={rank === 0 ? <OpenLockIcon sx={{ fontSize: '0.75rem !important' }} /> : <LockIcon sx={{ fontSize: '0.75rem !important' }} />}
            sx={{ bgcolor: `${secColor}1E`, color: secColor, fontWeight: 700, fontSize: '0.68rem', height: 22 }}
          />
        </Box>

        {/* The join that makes this more than a config dump */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mt: 1.5 }}>
          <Typography sx={{ fontSize: '1.4rem', fontWeight: 800, color: w.client_count ? t.ink : t.muted, lineHeight: 1 }}>
            {w.client_count}
          </Typography>
          <Typography sx={{ fontSize: '0.75rem', color: t.muted }}>
            client{w.client_count === 1 ? '' : 's'} connected now
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.25 }}>
          {!w.enabled && <Flag t={t} color={t.muted} icon={<WifiOffIcon />} label="Disabled" />}
          {w.hidden && <Flag t={t} color={t.inkSoft} icon={<HiddenIcon />} label="Hidden" />}
          {w.client_isolation && <Flag t={t} color={t.inkSoft} icon={<BlockIcon />} label="Isolated" />}
          {w.scheduled_off && <Flag t={t} color={t.inkSoft} icon={<ScheduleIcon />} label="Scheduled" />}
          {!!w.mac_filter_count && (
            <Flag t={t} color={warn} icon={<BlockIcon />} label={`MAC ${prettify(w.mac_filter_action)} (${w.mac_filter_count})`} />
          )}
        </Box>
      </Box>
    </motion.div>
  );
}

// ── Network / VLAN card ──────────────────────────────────────────────────────
function NetworkCard({ n, t, cardBg, ok, warn, index }: {
  n: Network; t: Tk; cardBg: string; ok: string; warn: string; index: number;
}) {
  const size = poolSize(n.dhcp_start, n.dhcp_stop);
  // Pool utilization is a rough gauge — clients on the VLAN may hold static
  // addresses — but an 8% used /24 pool is still worth seeing at a glance.
  const util = size ? Math.min(100, (n.client_count / size) * 100) : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.03, 0.3) }}
    >
      <Box sx={{
        p: 2, borderRadius: 2, border: `1px solid ${t.line}`, background: cardBg,
        borderLeft: `3px solid ${n.enabled ? t.rust : t.muted}`, opacity: n.enabled ? 1 : 0.6, height: '100%',
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography sx={{ fontWeight: 700, color: t.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.name}
          </Typography>
          {n.is_default && <Chip size="small" label="Default" sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${t.line}66`, color: t.inkSoft }} />}
          <Chip
            size="small" label={n.vlan_id ? `VLAN ${n.vlan_id}` : 'Untagged'}
            sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${t.rust}1E`, color: t.rust, fontWeight: 700 }}
          />
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 0.4, columnGap: 1.25, fontSize: '0.76rem' }}>
          <Detail t={t} label="Subnet">{n.subnet ?? '—'}</Detail>
          <Detail t={t} label="DHCP">
            {n.dhcp_start && n.dhcp_stop
              ? `${n.dhcp_start} – ${n.dhcp_stop}${size ? ` (${size})` : ''}`
              : n.dhcp_mode ? prettify(n.dhcp_mode) : '—'}
          </Detail>
          <Detail t={t} label="Lease">{fmtLease(n.dhcp_lease_seconds)}</Detail>
          {!!n.dhcp_dns.length && <Detail t={t} label="DNS">{n.dhcp_dns.join(', ')}</Detail>}
        </Box>

        <Box sx={{ mt: 1.25 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
            <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>
              {n.client_count} client{n.client_count === 1 ? '' : 's'} on this network
            </Typography>
            {util != null && (
              <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>{util.toFixed(0)}% of pool</Typography>
            )}
          </Box>
          {util != null && (
            <LinearProgress
              variant="determinate" value={util}
              sx={{ height: 5, borderRadius: 2, bgcolor: t.line, '& .MuiLinearProgress-bar': { bgcolor: util > 80 ? warn : ok, borderRadius: 2 } }}
            />
          )}
        </Box>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.25 }}>
          {n.internet_access === false && <Flag t={t} color={warn} icon={<BlockIcon />} label="No internet" />}
          {n.isolation && <Flag t={t} color={t.inkSoft} icon={<BlockIcon />} label="Isolated" />}
          {n.mdns && <Flag t={t} color={t.inkSoft} icon={<DnsIcon />} label="mDNS" />}
          {n.management && n.management !== 'GATEWAY' && <Flag t={t} color={t.muted} icon={<SwitchingIcon />} label={prettify(n.management)} />}
        </Box>
      </Box>
    </motion.div>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────
function Detail({ t, label, children }: { t: Tk; label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="span" sx={{ fontSize: '0.76rem', color: t.muted }}>{label}</Typography>
      <Typography component="span" sx={{ fontSize: '0.76rem', color: t.inkSoft, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {children}
      </Typography>
    </>
  );
}

function Flag({ t, color, icon, label }: { t: Tk; color: string; icon: ReactNode; label: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35, px: 0.75, py: 0.2, borderRadius: 1, bgcolor: `${color}18`, color }}>
      <Box sx={{ display: 'grid', placeItems: 'center', '& svg': { fontSize: '0.8rem' } }}>{icon}</Box>
      <Typography sx={{ fontSize: '0.66rem', fontWeight: 700, color: t.ink }}>{label}</Typography>
    </Box>
  );
}

function Tile({ t, cardBg, label, value, icon, accent, hint }: {
  t: Tk; cardBg: string; label: string; value: number; icon: ReactNode; accent: string; hint?: string;
}) {
  const body = (
    <Box sx={{ p: 1.5, borderRadius: 2, border: `1px solid ${t.line}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 1.25, height: '100%' }}>
      <Box sx={{ width: 34, height: 34, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${accent}1E`, color: accent, flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '1.3rem', lineHeight: 1, fontWeight: 800, color: t.ink }}>{value}</Typography>
        <Typography sx={{ fontSize: '0.68rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.04em', mt: 0.25 }}>{label}</Typography>
      </Box>
    </Box>
  );
  return hint ? <Tooltip title={hint} arrow>{body}</Tooltip> : body;
}

function SectionHeading({ t, icon, title, caption }: { t: Tk; icon: ReactNode; title: string; caption?: string }) {
  return (
    <Scrim sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, mt: 4, mb: 2 }}>
      <Box sx={{ color: t.rust, display: 'grid', placeItems: 'center' }}>{icon}</Box>
      <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', color: t.ink }}>{title}</Typography>
      {caption && <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>· {caption}</Typography>}
    </Scrim>
  );
}

function EmptyNote({ t, text }: { t: Tk; text: string }) {
  return <Typography sx={{ color: t.muted, fontSize: '0.85rem', py: 2 }}>{text}</Typography>;
}
