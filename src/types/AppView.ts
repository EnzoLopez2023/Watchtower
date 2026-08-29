/**
 * Watchtower view identifiers.
 *
 * The eleven production views keep the **exact** ids the ownership manifest
 * records (`docs/OWNERSHIP.md`, `lib/db/import/ownership.ts` → `OWNED_VIEW_IDS`).
 * That is deliberate: the imported per-view permission rows are keyed by those
 * ids, so using them verbatim makes `featurePermissions[view]` a direct lookup
 * with no translation table to drift out of step. The standalone URL a view is
 * served at lives in `app/navigation.ts`, not here.
 *
 * `admin` and `settings` are app-local screens that never existed in the
 * monolith, so they carry no production id and can never match an imported
 * permission row.
 */
export type ProductionView =
  | 'azure-command-center'
  | 'system-status'
  | 'observability'
  | 'power-monitor'
  | 'power-topology'
  | 'unifi-network'
  | 'unifi-topology'
  | 'unifi-config'
  | 'synology'
  | 'ip-migration'
  | 'protect';

/** Screens that exist only in the standalone app. */
export type LocalView = 'admin' | 'settings';

export type AppView = ProductionView | LocalView;

/** In manifest order. The server validates writes against this same set. */
export const PRODUCTION_VIEWS: readonly ProductionView[] = [
  'azure-command-center',
  'system-status',
  'observability',
  'power-monitor',
  'power-topology',
  'unifi-network',
  'unifi-topology',
  'unifi-config',
  'synology',
  'ip-migration',
  'protect',
] as const;

export const LOCAL_VIEWS: readonly LocalView[] = ['admin', 'settings'] as const;

export const APP_VIEWS: readonly AppView[] = [...PRODUCTION_VIEWS, ...LOCAL_VIEWS];

const PRODUCTION_SET = new Set<string>(PRODUCTION_VIEWS);
const VIEW_SET = new Set<string>(APP_VIEWS);

export const isAppView = (value: string): value is AppView => VIEW_SET.has(value);

/** True for the eleven ids an imported permission row can be keyed by. */
export const isProductionView = (value: AppView): value is ProductionView =>
  PRODUCTION_SET.has(value);
