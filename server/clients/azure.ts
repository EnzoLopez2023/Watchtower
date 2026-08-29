import { DefaultAzureCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { ContainerRegistryManagementClient } from "@azure/arm-containerregistry";
import { CognitiveServicesManagementClient } from "@azure/arm-cognitiveservices";
import { MonitorClient } from "@azure/arm-monitor";
// @azure/arm-resourcehealth ships as CJS only — default-import workaround.
import { MicrosoftResourceHealth } from "@azure/arm-resourcehealth";
import { CostManagementClient } from "@azure/arm-costmanagement";
import type { AppConfig } from "../config.js";

export interface AzureArmClients {
  resources(): ResourceManagementClient;
  webApps(): WebSiteManagementClient;
  acr(): ContainerRegistryManagementClient;
  cognitive(): CognitiveServicesManagementClient;
  monitor(): MonitorClient;
  health(): MicrosoftResourceHealth;
  cost(): CostManagementClient;
}

export function createAzureArmClients(config: AppConfig["azure"]): AzureArmClients {
  const credential = new DefaultAzureCredential();
  const subId = config.subscriptionId;

  let _resources: ResourceManagementClient | undefined;
  let _webApps: WebSiteManagementClient | undefined;
  let _acr: ContainerRegistryManagementClient | undefined;
  let _cognitive: CognitiveServicesManagementClient | undefined;
  let _monitor: MonitorClient | undefined;
  let _health: MicrosoftResourceHealth | undefined;
  let _cost: CostManagementClient | undefined;

  return {
    resources() {
      return (_resources ??= new ResourceManagementClient(credential, subId));
    },
    webApps() {
      return (_webApps ??= new WebSiteManagementClient(credential, subId));
    },
    acr() {
      return (_acr ??= new ContainerRegistryManagementClient(credential, subId));
    },
    cognitive() {
      return (_cognitive ??= new CognitiveServicesManagementClient(credential, subId));
    },
    monitor() {
      return (_monitor ??= new MonitorClient(credential, subId));
    },
    health() {
      return (_health ??= new MicrosoftResourceHealth(credential, subId));
    },
    cost() {
      return (_cost ??= new CostManagementClient(credential));
    },
  };
}

// ── Bounded TTL cache ─────────────────────────────────────────────────────

const CACHE_CAP = 500;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export interface AzureCache {
  get<T>(key: string, ttlSeconds: number, supplier: () => Promise<T>): Promise<T>;
  bust(prefix: string): void;
  size(): number;
}

export function createAzureCache(): AzureCache {
  const store = new Map<string, CacheEntry<unknown>>();

  function evictExpiredOrOldest(): void {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expires <= now) store.delete(k);
    }
    if (store.size >= CACHE_CAP) {
      // Evict the first (oldest-inserted) entry.
      const firstKey = store.keys().next().value;
      if (firstKey !== undefined) store.delete(firstKey);
    }
  }

  return {
    async get<T>(key: string, ttlSeconds: number, supplier: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const hit = store.get(key) as CacheEntry<T> | undefined;
      if (hit && hit.expires > now) return hit.value;
      const value = await supplier();
      evictExpiredOrOldest();
      store.set(key, { value, expires: now + ttlSeconds * 1000 });
      return value;
    },
    bust(prefix: string): void {
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) store.delete(k);
      }
    },
    size(): number {
      return store.size;
    },
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
