/// <reference types="vite/client" />

interface Window {
  readonly __WATCHTOWER_RUNTIME_CONFIG__?: {
    readonly entra: {
      readonly tenantId: string;
      readonly clientId: string;
      readonly apiScope: string;
    };
  };
}
