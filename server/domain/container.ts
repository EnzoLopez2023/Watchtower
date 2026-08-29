import type { SqliteDatabase } from "../../lib/db/connection.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteAgentLogRepository } from "../../lib/db/repositories/watchtower/agentLogRepository.js";
import { SqliteAlertStateRepository } from "../../lib/db/repositories/watchtower/alertStateRepository.js";
import { SqliteInfraStatusRepository } from "../../lib/db/repositories/watchtower/infraStatusRepository.js";
import { SqliteIpPlanRepository } from "../../lib/db/repositories/watchtower/ipPlanRepository.js";
import { SqliteMobilePushRepository } from "../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { SqliteMonitoringArchiveRepository } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import { SqliteNetworkObserverRepository } from "../../lib/db/repositories/watchtower/networkObserverRepository.js";
import { SqliteOutageRepository } from "../../lib/db/repositories/watchtower/outageRepository.js";
import { SqlitePowerTopologyRepository } from "../../lib/db/repositories/watchtower/powerTopologyRepository.js";
import { SqliteProtectRepository } from "../../lib/db/repositories/watchtower/protectRepository.js";
import { SqliteSynologyRepository } from "../../lib/db/repositories/watchtower/synologyRepository.js";
import { SqliteUnifiLogsRepository } from "../../lib/db/repositories/watchtower/unifiLogsRepository.js";
import type { ArchiveStatusReader } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import { SqliteUnifiRepository } from "../../lib/db/repositories/watchtower/unifiRepository.js";
import { SqliteUpsRepository } from "../../lib/db/repositories/watchtower/upsRepository.js";
import { AlertEngine } from "../../lib/monitoring/alertEngine.js";
import {
  buildInfraStatus,
  observerAlertSamples,
  type DashboardPayload
} from "../../lib/monitoring/infraStatus.js";
import { PushDeliveryService } from "../../lib/monitoring/pushDelivery.js";
import { createApnsProvider, type ApnsProvider } from "../clients/apns.js";
import { createAzureArmClients, createAzureCache, type AzureArmClients, type AzureCache } from "../clients/azure.js";
import {
  createMediaHealthClient,
  type MediaHealthClient
} from "../clients/marqueeMediaHealth.js";
import type { AppConfig } from "../config.js";

export interface WatchtowerRepositories {
  readonly receipts: SqliteAgentIngestReceiptRepository;
  readonly archive: SqliteMonitoringArchiveRepository;
  readonly archiveStatus: ArchiveStatusReader;
  readonly unifi: SqliteUnifiRepository;
  readonly unifiLogs: SqliteUnifiLogsRepository;
  readonly ups: SqliteUpsRepository;
  readonly protect: SqliteProtectRepository;
  readonly synology: SqliteSynologyRepository;
  readonly networkObserver: SqliteNetworkObserverRepository;
  readonly agentLogs: SqliteAgentLogRepository;
  readonly powerTopology: SqlitePowerTopologyRepository;
  readonly ipPlan: SqliteIpPlanRepository;
  readonly outage: SqliteOutageRepository;
  readonly infraStatus: SqliteInfraStatusRepository;
  readonly mobilePush: SqliteMobilePushRepository;
  readonly alertState: SqliteAlertStateRepository;
}

export interface WatchtowerServices {
  readonly mediaHealth: MediaHealthClient;
  readonly apns: ApnsProvider;
  readonly push: PushDeliveryService;
  readonly alertEngine: AlertEngine;
  readonly azureClients: AzureArmClients;
  readonly azureCache: AzureCache;
  readonly buildStatus: () => Promise<DashboardPayload>;
}

export interface WatchtowerContainer {
  readonly config: AppConfig;
  readonly database: SqliteDatabase;
  readonly repositories: WatchtowerRepositories;
  readonly services: WatchtowerServices;
}

export interface ContainerOverrides {
  readonly mediaHealth?: MediaHealthClient;
  readonly apns?: ApnsProvider;
  readonly azureClients?: AzureArmClients;
  readonly log?: (message: string) => void;
}

/**
 * Assembles the monitoring object graph. Every collaborator is constructed here
 * and injected downward, so route, worker and domain code never reaches for a
 * module-level singleton and tests can substitute any edge.
 */
export function createWatchtowerContainer(
  database: SqliteDatabase,
  config: AppConfig,
  overrides: ContainerOverrides = {}
): WatchtowerContainer {
  const archive = new SqliteMonitoringArchiveRepository(database, config.monitoringArchive.enabled);
  // Read-only archive status for the interactive surface. Declared as its own
  // async contract so a route never receives the synchronous retention methods
  // that only adapters may call from inside a transaction.
  const archiveStatus: ArchiveStatusReader = {
    archiveSummary: () => archive.archiveSummary()
  };

  const receipts = new SqliteAgentIngestReceiptRepository(database);
  const repositories: WatchtowerRepositories = {
    receipts,
    archive,
    archiveStatus,
    unifi: new SqliteUnifiRepository(database, receipts),
    unifiLogs: new SqliteUnifiLogsRepository(database, receipts, archive),
    ups: new SqliteUpsRepository(database, receipts),
    protect: new SqliteProtectRepository(database, receipts),
    synology: new SqliteSynologyRepository(database, receipts),
    networkObserver: new SqliteNetworkObserverRepository(database, receipts),
    agentLogs: new SqliteAgentLogRepository(database, receipts, archive),
    powerTopology: new SqlitePowerTopologyRepository(database),
    ipPlan: new SqliteIpPlanRepository(database),
    outage: new SqliteOutageRepository(database),
    infraStatus: new SqliteInfraStatusRepository(database),
    mobilePush: new SqliteMobilePushRepository(database),
    alertState: new SqliteAlertStateRepository(database)
  };

  const log = overrides.log;
  const mediaHealth = overrides.mediaHealth ?? createMediaHealthClient(config.marquee);
  const apns = overrides.apns ?? createApnsProvider(config.apns);
  const push = new PushDeliveryService(repositories.mobilePush, apns, log);
  const samples = {
    failure: observerAlertSamples(process.env.NETWORK_OBSERVER_ALERT_FAILURE_SAMPLES),
    recovery: observerAlertSamples(process.env.NETWORK_OBSERVER_ALERT_RECOVERY_SAMPLES)
  };
  const buildStatus = (): Promise<DashboardPayload> =>
    buildInfraStatus({
      repository: repositories.infraStatus,
      routeDrift: repositories.unifi,
      mediaHealth,
      observerAlertSamples: samples
    });

  const alertEngine = new AlertEngine({
    repository: repositories.alertState,
    buildStatus,
    deliver: (notification, options) => push.deliver(notification, options),
    plan: (notification) => push.plan(notification),
    apnsConfigured: () => apns.configured(),
    ...(log ? { log } : {})
  });

  const services: WatchtowerServices = {
    mediaHealth,
    apns,
    push,
    alertEngine,
    azureClients: overrides.azureClients ?? createAzureArmClients(config.azure),
    azureCache: createAzureCache(),
    buildStatus
  };

  return { config, database, repositories, services };
}
