/**
 * Deployment/runtime contract: the machine-readable single source of truth for
 * the Watchtower Azure App Service (Linux) deployment, plus the production
 * startup storage gate and its injectable probe.
 */

export {
  DEPLOYMENT_CONTRACT,
  PRODUCTION_DATABASE_PATH,
  parseDeploymentContract,
  type DeploymentContract,
  type PersistentStorageContract,
  type RequiredEnvContract
} from "./contract.js";
export {
  defaultPersistentStorageProbe,
  parseMountInfoPoints,
  type PersistentStorageProbe,
  type WriteProbeResult
} from "./persistentStorageProbe.js";
export {
  DeploymentContractError,
  assertPersistentStorage,
  enforcePersistentStorageContract,
  verifyPersistentStorage,
  type BootstrapStorageConfig,
  type EnforcePersistentStorageOptions,
  type StorageRejectionCode,
  type StorageVerification,
  type VerifyPersistentStorageOptions
} from "./storageGate.js";
