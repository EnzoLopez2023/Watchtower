import { Router } from "express";
import { enforceFeatureAccess, mountedRoutes } from "../auth/featureRoutes.js";
import type { WatchtowerContainer } from "../domain/container.js";
import { createAgentLogsRouter, createAgentLogsServiceRouter } from "./features/agentLogs.js";
import { createAzureRouter } from "./features/azure.js";
import { createIpPlanRouter } from "./features/ipPlan.js";
import { createMobileServiceRouter } from "./features/mobile.js";
import {
  createNetworkObserverRouter,
  createNetworkObserverServiceRouter
} from "./features/networkObserver.js";
import { createPowerTopologyRouter } from "./features/powerTopology.js";
import { createProtectRouter, createProtectServiceRouter } from "./features/protect.js";
import { createStatusRouter } from "./features/status.js";
import { createSynologyRouter, createSynologyServiceRouter } from "./features/synology.js";
import { createUnifiRouter, createUnifiServiceRouter } from "./features/unifi.js";
import { createUnifiLogsRouter, createUnifiLogsServiceRouter } from "./features/unifiLogs.js";
import { createUpsRouter, createUpsServiceRouter } from "./features/ups.js";

export interface FeatureRouters {
  /** Shared-secret surface. Mounted before body parsing and before Entra auth. */
  readonly service: Router;
  /** Verified-identity surface. Mounted after Entra auth. */
  readonly interactive: Router;
}

/**
 * Splits the feature surface in two.
 *
 * The service router carries the headless collectors and the mobile app: each
 * authenticates with its own constant-time shared secret and declares its own
 * body limit, so the 50 MB ingest allowance never applies to anything else.
 * Everything in the interactive router requires a verified Entra identity and an
 * app-local role — viewer to read, operator to write, admin for observability.
 */
export function createFeatureRouters(container: WatchtowerContainer): FeatureRouters {
  const { config, repositories, services } = container;

  const service = Router();
  service.use(
    createUnifiServiceRouter({
      config,
      repository: repositories.unifi,
    })
  );
  service.use(
    createUnifiLogsServiceRouter({
      config,
      logsRepository: repositories.unifiLogs,
    })
  );
  service.use(
    createUpsServiceRouter({
      config,
      repository: repositories.ups,
    })
  );
  service.use(
    createProtectServiceRouter({
      config,
      repository: repositories.protect,
    })
  );
  service.use(
    createSynologyServiceRouter({
      config,
      repository: repositories.synology,
    })
  );
  service.use(
    createNetworkObserverServiceRouter({
      config,
      repository: repositories.networkObserver,
    })
  );
  service.use(
    createAgentLogsServiceRouter({
      config,
      repository: repositories.agentLogs,
    })
  );
  service.use(
    createMobileServiceRouter({
      config,
      repository: repositories.mobilePush,
      push: services.push,
      apns: services.apns,
      buildStatus: services.buildStatus
    })
  );

  const features = Router();
  features.use(createStatusRouter({ buildStatus: services.buildStatus }));
  features.use(createUnifiRouter({ repository: repositories.unifi, outage: repositories.unifi }));
  features.use(
    createUnifiLogsRouter({
      logsRepository: repositories.unifiLogs,
      unifiRepository: repositories.unifi,
      archiveStatus: repositories.archiveStatus
    })
  );
  features.use(createUpsRouter({ repository: repositories.ups }));
  features.use(createProtectRouter({ repository: repositories.protect }));
  features.use(createSynologyRouter({ repository: repositories.synology }));
  features.use(
    createNetworkObserverRouter({ config, repository: repositories.networkObserver })
  );
  features.use(createAgentLogsRouter({ config, repository: repositories.agentLogs }));
  features.use(createPowerTopologyRouter({ repository: repositories.powerTopology }));
  features.use(createIpPlanRouter({ repository: repositories.ipPlan }));
  features.use(
    createAzureRouter({ config, clients: services.azureClients, cache: services.azureCache })
  );

  /**
   * The feature guard is mounted ahead of the routers it protects, and is built
   * from the routers themselves, so an endpoint cannot be added without either
   * declaring its access rule or being refused.
   */
  const interactive = Router();
  interactive.use(enforceFeatureAccess({ mounted: mountedRoutes(features) }));
  interactive.use(features);

  return { service, interactive };
}
