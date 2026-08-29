/**
 * The machine-readable deployment/runtime contract for the Watchtower Azure App
 * Service (Linux) deployment.
 *
 * `CONTRACT_DOCUMENT` below is the single source of truth. It is consumed by the
 * production startup storage gate ({@link file://./storageGate.ts}), by
 * `server/config.ts`, and by the tests, so the runtime can never drift from the
 * documented contract.
 *
 * `deployment.contract.json` (next to this module) is a checked-in serialization
 * of the same contract for external infrastructure-as-code and deployment
 * tooling. A test (`test/deployment/contract.test.ts`) parses that file and
 * asserts it is structurally identical to `DEPLOYMENT_CONTRACT`, so the JSON
 * mirror and this code cannot diverge.
 */

export interface RequiredEnvContract {
  /** The App Service application-setting name that must be present. */
  readonly name: string;
  /** The exact string value that setting must hold (compared verbatim). */
  readonly value: string;
}

export interface PersistentStorageContract {
  /** The App Service setting that enables the persistent `/home` share. */
  readonly requiredEnv: RequiredEnvContract;
  /** The persistent mount point that must appear in the kernel mount table. */
  readonly mountPoint: string;
  /** The directory, on that mount, that holds the SQLite authority. */
  readonly dataDirectory: string;
  /** The one authoritative SQLite database path. */
  readonly databasePath: string;
  /** Off-host backup root, also on the persistent mount. */
  readonly backupRoot: string;
  /**
   * The journal mode this single-writer deployment requires. WAL would place
   * `-wal`/`-shm` sidecars on the App Service share, where its file locking
   * cannot be relied on; DELETE keeps the database a single file.
   */
  readonly journalMode: RequiredEnvContract;
}

export interface ContainerRegistryContract {
  readonly mode: string;
  readonly name: string;
  readonly loginServer: string;
  readonly dedicatedRegistryAllowed: boolean;
}

/**
 * Facts the platform template guarantees, which the app cannot verify from
 * inside the container at runtime. They are asserted against the deployment
 * evidence (the audit script and the image), not probed on startup.
 */
export interface DeploymentEvidenceContract {
  /** `deploymentProfile` in the bicepparam. */
  readonly deploymentProfile: string;
  /** `dataStorageMode` in the bicepparam; drives the storage app setting. */
  readonly dataStorageMode: string;
  /** `siteConfig.numberOfWorkers`. A second worker would mean two writers. */
  readonly numberOfWorkers: number;
  /** `siteConfig.alwaysOn`. */
  readonly alwaysOn: boolean;
  /** The port the container listens on. */
  readonly containerPort: number;
  readonly healthCheckPath: string;
  readonly readinessPath: string;
  /**
   * The image must declare no Docker `VOLUME` at the mount point or below: a
   * VOLUME there shadows the platform's persistent share with an anonymous,
   * ephemeral volume, which is invisible to every runtime probe because the
   * directory still looks like a genuine non-root-device mount.
   */
  readonly forbiddenImageVolumePrefix: string;
}

export interface DeploymentContract {
  readonly schema: string;
  readonly platform: string;
  readonly containerRegistry: ContainerRegistryContract;
  readonly persistentStorage: PersistentStorageContract;
  readonly evidence: DeploymentEvidenceContract;
}

/**
 * The authoritative contract, in code. Kept identical to
 * `deployment.contract.json` by a test. Edit both together (or edit one and let
 * the sync test tell you about the other).
 */
const CONTRACT_DOCUMENT = {
  schema: "watchtower.deployment.contract.v3",
  platform: "azure-app-service-linux",
  containerRegistry: {
    mode: "shared-existing",
    name: "acrenzolopez01",
    loginServer: "acrenzolopez01.azurecr.io",
    dedicatedRegistryAllowed: false
  },
  persistentStorage: {
    requiredEnv: {
      name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE",
      value: "true"
    },
    mountPoint: "/home",
    dataDirectory: "/home/data",
    databasePath: "/home/data/watchtower.db",
    backupRoot: "/home/data/backups/watchtower",
    journalMode: {
      name: "SQLITE_JOURNAL_MODE",
      value: "DELETE"
    }
  },
  evidence: {
    deploymentProfile: "sqlite-one-worker",
    dataStorageMode: "persistent",
    numberOfWorkers: 1,
    alwaysOn: true,
    containerPort: 3000,
    healthCheckPath: "/api/live",
    readinessPath: "/api/ready",
    forbiddenImageVolumePrefix: "/home"
  }
} as const;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`deployment contract ${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`deployment contract ${context} must be a non-empty string`);
  }
  return value;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`deployment contract ${context} must be a positive integer`);
  }
  return value;
}

function asBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`deployment contract ${context} must be a boolean`);
  }
  return value;
}

function requiredEnvOf(raw: unknown, context: string): RequiredEnvContract {
  const record = asRecord(raw, context);
  return Object.freeze({
    name: asNonEmptyString(record.name, `${context}.name`),
    value: asNonEmptyString(record.value, `${context}.value`)
  });
}

/**
 * Validates the raw contract document and returns a deeply frozen, typed view.
 * The check is defensive: a malformed contract is a deployment configuration
 * error and must fail loudly at import time rather than silently disabling a
 * runtime safety check.
 */
export function parseDeploymentContract(raw: unknown): DeploymentContract {
  const root = asRecord(raw, "root");
  const storage = asRecord(root.persistentStorage, "persistentStorage");
  const containerRegistry = asRecord(root.containerRegistry, "containerRegistry");
  const evidence = asRecord(root.evidence, "evidence");
  return Object.freeze({
    schema: asNonEmptyString(root.schema, "schema"),
    platform: asNonEmptyString(root.platform, "platform"),
    containerRegistry: Object.freeze({
      mode: asNonEmptyString(containerRegistry.mode, "containerRegistry.mode"),
      name: asNonEmptyString(containerRegistry.name, "containerRegistry.name"),
      loginServer: asNonEmptyString(
        containerRegistry.loginServer,
        "containerRegistry.loginServer"
      ),
      dedicatedRegistryAllowed: asBoolean(
        containerRegistry.dedicatedRegistryAllowed,
        "containerRegistry.dedicatedRegistryAllowed"
      )
    }),
    persistentStorage: Object.freeze({
      requiredEnv: requiredEnvOf(storage.requiredEnv, "persistentStorage.requiredEnv"),
      mountPoint: asNonEmptyString(storage.mountPoint, "persistentStorage.mountPoint"),
      dataDirectory: asNonEmptyString(storage.dataDirectory, "persistentStorage.dataDirectory"),
      databasePath: asNonEmptyString(storage.databasePath, "persistentStorage.databasePath"),
      backupRoot: asNonEmptyString(storage.backupRoot, "persistentStorage.backupRoot"),
      journalMode: requiredEnvOf(storage.journalMode, "persistentStorage.journalMode")
    }),
    evidence: Object.freeze({
      deploymentProfile: asNonEmptyString(evidence.deploymentProfile, "evidence.deploymentProfile"),
      dataStorageMode: asNonEmptyString(evidence.dataStorageMode, "evidence.dataStorageMode"),
      numberOfWorkers: asPositiveInteger(evidence.numberOfWorkers, "evidence.numberOfWorkers"),
      alwaysOn: asBoolean(evidence.alwaysOn, "evidence.alwaysOn"),
      containerPort: asPositiveInteger(evidence.containerPort, "evidence.containerPort"),
      healthCheckPath: asNonEmptyString(evidence.healthCheckPath, "evidence.healthCheckPath"),
      readinessPath: asNonEmptyString(evidence.readinessPath, "evidence.readinessPath"),
      forbiddenImageVolumePrefix: asNonEmptyString(
        evidence.forbiddenImageVolumePrefix,
        "evidence.forbiddenImageVolumePrefix"
      )
    })
  });
}

/** The one authoritative deployment contract for the running process. */
export const DEPLOYMENT_CONTRACT: DeploymentContract = parseDeploymentContract(CONTRACT_DOCUMENT);

/**
 * The fixed production SQLite authority path. Re-exported so `server/config.ts`
 * and the runtime gate share exactly one literal.
 */
export const PRODUCTION_DATABASE_PATH: string =
  DEPLOYMENT_CONTRACT.persistentStorage.databasePath;
