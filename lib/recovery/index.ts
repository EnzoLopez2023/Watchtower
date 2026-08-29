/**
 * Public surface of the Watchtower recovery layer.
 *
 * Nothing here runs on startup or on a request. Every entry point is an explicit
 * command with explicit paths.
 */

export {
  RecoveryError,
  isRecoveryError,
  describeRecoveryError,
  type RecoveryErrorCode
} from "./errors.js";

export {
  assertLowerHex,
  assertSafeDestination,
  findGitWorktreeRoot,
  isInside,
  sha256File,
  type DestinationOptions
} from "./paths.js";

export {
  RECENCY_COLUMNS,
  readSchemaVersionIdentity,
  readTableSnapshots,
  runSnapshotChecks,
  type SchemaVersionIdentity,
  type SnapshotChecks,
  type TableSnapshot
} from "./snapshot.js";

export {
  BACKUP_CONTRACT,
  BACKUP_CONTRACT_VERSION,
  BACKUP_MANIFEST_FILE,
  BACKUP_SNAPSHOT_FILE,
  DEFAULT_STALE_PARTIAL_MS,
  createBackup,
  pruneStalePartials,
  readBackupManifest,
  verifyBackup,
  type BackupManifest,
  type BackupFaultHooks,
  type CreateBackupOptions,
  type PrunedPartial,
  type CreateBackupResult,
  type VerifyBackupResult
} from "./backup.js";

export {
  FORBIDDEN_CREDENTIAL_VARIABLES,
  assertManagedIdentityOnlyEnvironment,
  blobUrl,
  readBlobDigest,
  uploadBlob,
  validateBlobName,
  validateStorageAccount,
  validateStorageContainer,
  type BlobClientOptions,
  type BlobReadbackResult,
  type BlobUploadResult
} from "./managedIdentityBlob.js";

export {
  DRILL_CONTRACT,
  DRILL_CONTRACT_VERSION,
  runRecoveryDrill,
  writeDrillEvidence,
  type DrillStepTiming,
  type RecoveryDrillEvidence,
  type RecoveryDrillOptions,
  type RecoveryDrillResult
} from "./drill.js";

export {
  restoreBundle,
  uploadBundleWithReadback,
  type OffhostUploadResult,
  type RestoreResult
} from "./offhost.js";
