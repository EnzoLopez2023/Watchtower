/**
 * The Watchtower navigation model.
 *
 * One table maps a URL to a view id, a label, an icon and the group it sits in.
 * The router, the navigation rail, the mobile drawer, the document title and
 * the theme's per-page appearance all read from it, so a route can never exist
 * in one of those and be missing from another.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import {
  AdminPanelSettings as AdminIcon,
  Bolt as PowerIcon,
  CloudQueue as AzureIcon,
  Hub as TopologyIcon,
  Lan as NetworkIcon,
  MonitorHeart as StatusIcon,
  QueryStats as ObservabilityIcon,
  Router as ConfigIcon,
  SettingsOutlined as SettingsIcon,
  Storage as SynologyIcon,
  SwapHoriz as IpIcon,
  Videocam as ProtectIcon,
} from '@mui/icons-material';
import type { AppView } from '../types/AppView';

/**
 * Session key carrying the "open on Telemetry" deep link from the Observability
 * console to the UniFi network page. Both sides import this constant so the two
 * halves of the hand-off cannot drift apart.
 */
export const NAV_TELEMETRY_DEEP_LINK = 'unifi-initial-tab';

export type NavGroup = 'operations' | 'network' | 'account';

export interface NavRoute {
  readonly view: AppView;
  readonly path: string;
  readonly label: string;
  /** Short form for the collapsed rail and the browser tab. */
  readonly short: string;
  readonly icon: SvgIconComponent;
  readonly group: NavGroup;
  /** True when the route is only reachable by an administrator. */
  readonly adminOnly?: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  {
    view: 'system-status',
    path: '/status',
    label: 'System Status',
    short: 'Status',
    icon: StatusIcon,
    group: 'operations',
  },
  {
    view: 'azure-command-center',
    path: '/azure',
    label: 'Azure Command Center',
    short: 'Azure',
    icon: AzureIcon,
    group: 'operations',
  },
  {
    view: 'observability',
    path: '/observability',
    label: 'Observability',
    short: 'Observability',
    icon: ObservabilityIcon,
    group: 'operations',
  },
  {
    view: 'power-monitor',
    path: '/power',
    label: 'Power & UPS',
    short: 'Power',
    icon: PowerIcon,
    group: 'operations',
  },
  {
    view: 'power-topology',
    path: '/power/topology',
    label: 'Power Topology',
    short: 'Power map',
    icon: TopologyIcon,
    group: 'operations',
  },
  {
    view: 'unifi-network',
    path: '/network',
    label: 'UniFi Network',
    short: 'Network',
    icon: NetworkIcon,
    group: 'network',
  },
  {
    view: 'unifi-topology',
    path: '/network/topology',
    label: 'Network Topology',
    short: 'Net map',
    icon: TopologyIcon,
    group: 'network',
  },
  {
    view: 'unifi-config',
    path: '/network/config',
    label: 'UniFi Configuration',
    short: 'Net config',
    icon: ConfigIcon,
    group: 'network',
  },
  {
    view: 'protect',
    path: '/protect',
    label: 'Protect Cameras',
    short: 'Protect',
    icon: ProtectIcon,
    group: 'network',
  },
  {
    view: 'synology',
    path: '/synology',
    label: 'Synology Storage',
    short: 'Synology',
    icon: SynologyIcon,
    group: 'network',
  },
  {
    view: 'ip-migration',
    path: '/ip-migration',
    label: 'IP Migration Plan',
    short: 'IP plan',
    icon: IpIcon,
    group: 'network',
  },
  {
    view: 'admin',
    path: '/admin',
    label: 'Administration',
    short: 'Admin',
    icon: AdminIcon,
    group: 'account',
    adminOnly: true,
  },
  {
    view: 'settings',
    path: '/settings',
    label: 'Settings',
    short: 'Settings',
    icon: SettingsIcon,
    group: 'account',
  },
] as const;

export const GROUP_LABELS: Record<NavGroup, string> = {
  operations: 'Operations',
  network: 'Network & storage',
  account: 'Account',
};

export const GROUP_ORDER: readonly NavGroup[] = ['operations', 'network', 'account'];

const BY_VIEW = new Map<AppView, NavRoute>(NAV_ROUTES.map((r) => [r.view, r]));
const BY_PATH = new Map<string, NavRoute>(NAV_ROUTES.map((r) => [r.path, r]));

/** Where the app lands with no path of its own. */
export const DEFAULT_PATH = '/status';

export const routeForView = (view: AppView): NavRoute | undefined => BY_VIEW.get(view);

export const pathForView = (view: AppView): string => BY_VIEW.get(view)?.path ?? DEFAULT_PATH;

/**
 * The route a pathname belongs to.
 *
 * Longest match wins so `/network/topology` never resolves to `/network`.
 */
export function routeForPath(pathname: string): NavRoute | undefined {
  const exact = BY_PATH.get(pathname);
  if (exact) return exact;
  const normalised = pathname.replace(/\/+$/, '');
  if (normalised && normalised !== pathname) return BY_PATH.get(normalised);
  return undefined;
}

export const viewForPath = (pathname: string): AppView | null =>
  routeForPath(pathname)?.view ?? null;

/** Routes for one group, in table order. */
export const routesInGroup = (group: NavGroup): NavRoute[] =>
  NAV_ROUTES.filter((r) => r.group === group);
