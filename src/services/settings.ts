/**
 * Per-user settings, stored server-side under the signed-in identity.
 *
 * The server allows a fixed key set; anything else is rejected, so the keys are
 * mirrored here as a union rather than left open.
 */

import { apiGet, apiPut } from './apiClient';
import type { AppView } from '../types/AppView';
import type { AppearanceSettings } from '../theme/appearance';

export type SettingKey = 'appearance' | 'density' | 'timezone' | 'defaultView';

export type Density = 'comfortable' | 'compact';

export interface WatchtowerSettings {
  appearance?: AppearanceSettings;
  density?: Density;
  timezone?: string;
  defaultView?: AppView;
}

interface SettingsResponse {
  readonly settings: Readonly<Record<string, unknown>>;
}

export async function fetchSettings(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
  const response = await apiGet<SettingsResponse>(
    '/api/settings',
    signal ? { signal } : undefined,
  );
  return response.settings ?? {};
}

export const saveSetting = (key: SettingKey, value: unknown): Promise<void> =>
  apiPut<void>(`/api/settings/${key}`, value);
