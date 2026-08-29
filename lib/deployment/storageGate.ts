/**
 * Production startup gate for the persistent App Service storage contract.
 *
 * In production this must reject BEFORE the SQLite database file is created or
 * opened unless every one of these holds:
 *
 *   1. `WEBSITES_ENABLE_APP_SERVICE_STORAGE` is exactly `"true"`;
 *   2. the selected database authority resolves to the contract's
 *      `/home/data/watchtower.db`;
 *   3. the contract mount point (`/home`) is a real mount — present in the
 *      kernel mount table, not merely an image-local directory;
 *   4. the data directory (`/home/data`) exists on that mount and sits on a
 *      different filesystem device than the root image layer;
 *   5. the data directory is writable right now.
 *
 * A `/home/data` directory that Docker created inside the image layer (same
 * device as `/`, absent from the mount table) fails (3) and (4) and is rejected.
 *
 * All filesystem evidence is gathered through an injectable
 * {@link PersistentStorageProbe}, so tests drive every branch deterministically
 * without root or real mounts. Error messages name only public deployment paths
 * and `errno` codes — never environment values or secrets.
 */

import { resolve } from "node:path";
import { DEPLOYMENT_CONTRACT, type DeploymentContract } from "./contract.js";
import {
  defaultPersistentStorageProbe,
  type PersistentStorageProbe
} from "./persistentStorageProbe.js";

export type StorageRejectionCode =
  | "APP_SERVICE_STORAGE_DISABLED"
  | "DATABASE_PATH_NOT_AUTHORITY"
  | "PERSISTENT_MOUNT_ABSENT"
  | "DATA_DIRECTORY_ABSENT"
  | "PERSISTENT_MOUNT_NOT_DISTINCT"
  | "MOUNT_EVIDENCE_UNAVAILABLE"
  | "PERSISTENT_MOUNT_NOT_WRITABLE"
  | "DATABASE_PATH_SYMLINK_ESCAPE"
  | "SQLITE_JOURNAL_MODE_INVALID";

export type StorageVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: StorageRejectionCode; readonly reason: string };

export interface VerifyPersistentStorageOptions {
  /** The database path the process is configured to open. */
  readonly databasePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: PersistentStorageProbe;
  readonly contract?: DeploymentContract;
}

export class DeploymentContractError extends Error {
  public readonly code: StorageRejectionCode;

  public constructor(code: StorageRejectionCode, message: string) {
    super(message);
    this.name = "DeploymentContractError";
    this.code = code;
  }
}

/** Absolute path without a trailing slash so `/home/` and `/home` compare equal. */
function normalize(path: string): string {
  const resolved = resolve(path);
  return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function reject(code: StorageRejectionCode, reason: string): StorageVerification {
  return { ok: false, code, reason };
}

/**
 * Pure predicate for the persistent-storage contract. Environment-agnostic: the
 * caller decides when to enforce it (production only). Returns a structured
 * result rather than throwing so callers and tests can inspect the exact reason.
 */
export function verifyPersistentStorage(
  options: VerifyPersistentStorageOptions
): StorageVerification {
  const contract = options.contract ?? DEPLOYMENT_CONTRACT;
  const probe = options.probe ?? defaultPersistentStorageProbe;
  const env = options.env ?? process.env;
  const storage = contract.persistentStorage;

  // 1. The persistent-storage feature flag must be present and exactly "true".
  if (env[storage.requiredEnv.name] !== storage.requiredEnv.value) {
    return reject(
      "APP_SERVICE_STORAGE_DISABLED",
      `${storage.requiredEnv.name} must be exactly "${storage.requiredEnv.value}" before the database may be opened on persistent App Service storage`
    );
  }

  // 2. The configured authority must be the one contract database path.
  if (normalize(options.databasePath) !== normalize(storage.databasePath)) {
    return reject(
      "DATABASE_PATH_NOT_AUTHORITY",
      `the configured database path is not the persistent authority ${storage.databasePath}`
    );
  }

  // 3. The mount point must be a real mount, not an image-local directory.
  const mountPoints = new Set(probe.mountPoints().map(normalize));
  if (!mountPoints.has(normalize(storage.mountPoint))) {
    return reject(
      "PERSISTENT_MOUNT_ABSENT",
      `the persistent mount ${storage.mountPoint} is not present in the kernel mount table; refusing to open the database on an ephemeral image-local directory`
    );
  }

  // 4. The data directory must exist on that mount.
  const dataDirectory = normalize(storage.dataDirectory);
  const dataDeviceId = probe.deviceId(dataDirectory);
  if (dataDeviceId === undefined) {
    return reject(
      "DATA_DIRECTORY_ABSENT",
      `the data directory ${storage.dataDirectory} does not exist on the persistent mount`
    );
  }

  // 5. The data directory must live on a different device than the root
  //    filesystem: a same-device directory is an image layer, not the mount.
  const rootDeviceId = probe.deviceId("/");
  if (rootDeviceId === undefined) {
    return reject(
      "MOUNT_EVIDENCE_UNAVAILABLE",
      "the root filesystem device could not be read to compare against the persistent mount"
    );
  }
  if (dataDeviceId === rootDeviceId) {
    return reject(
      "PERSISTENT_MOUNT_NOT_DISTINCT",
      `the data directory ${storage.dataDirectory} shares the root filesystem device; a Docker image-layer directory is not persistent App Service storage`
    );
  }

  // 6. Neither the data directory nor an existing database file may be a
  //    symlink out of the persistent mount. Without this, the path check above
  //    is satisfied by a link that redirects every write to ephemeral storage.
  const realDataDirectory = probe.realPath(dataDirectory);
  if (realDataDirectory === undefined) {
    return reject(
      "DATA_DIRECTORY_ABSENT",
      `the data directory ${storage.dataDirectory} could not be resolved on the persistent mount`
    );
  }
  if (normalize(realDataDirectory) !== dataDirectory) {
    return reject(
      "DATABASE_PATH_SYMLINK_ESCAPE",
      `the data directory ${storage.dataDirectory} resolves elsewhere through a symlink; the persistent authority may not be redirected`
    );
  }
  // An absent database file is normal on first boot; only an existing one that
  // resolves outside the data directory is an escape.
  const realDatabasePath = probe.realPath(normalize(storage.databasePath));
  if (realDatabasePath !== undefined && normalize(realDatabasePath) !== normalize(storage.databasePath)) {
    return reject(
      "DATABASE_PATH_SYMLINK_ESCAPE",
      `the database path ${storage.databasePath} resolves elsewhere through a symlink; the persistent authority may not be redirected`
    );
  }

  // 7. The journal mode must be the single-file DELETE mode this deployment
  //    profile requires. WAL sidecars on the App Service share cannot be
  //    relied on for locking, so a mismatch is a deployment error, not a
  //    preference. Unset is accepted: the connection forces DELETE anyway.
  const journal = env[storage.journalMode.name];
  if (journal !== undefined && journal !== storage.journalMode.value) {
    return reject(
      "SQLITE_JOURNAL_MODE_INVALID",
      `${storage.journalMode.name} must be "${storage.journalMode.value}" for the ${contract.evidence.deploymentProfile} profile`
    );
  }

  // 8. The data directory must accept a full durable round trip right now:
  //    create, write every byte, fsync, read back, delete. The sentinel is a
  //    private file — never a row in the database, which is not opened yet.
  const write = probe.writeProbe(dataDirectory);
  if (!write.ok) {
    return reject(
      "PERSISTENT_MOUNT_NOT_WRITABLE",
      `the data directory ${storage.dataDirectory} did not complete a durable write/read-back probe (${write.code ?? "unknown"})`
    );
  }

  return { ok: true };
}

/**
 * Throws {@link DeploymentContractError} unless the persistent-storage contract
 * is satisfied. Environment-agnostic; see {@link enforcePersistentStorageContract}
 * for the production-only wiring used at startup.
 */
export function assertPersistentStorage(options: VerifyPersistentStorageOptions): void {
  const result = verifyPersistentStorage(options);
  if (!result.ok) {
    throw new DeploymentContractError(result.code, `Refusing to start: ${result.reason}.`);
  }
}

export interface BootstrapStorageConfig {
  readonly environment: string;
  readonly database: { readonly path: string };
}

export interface EnforcePersistentStorageOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: PersistentStorageProbe;
  readonly contract?: DeploymentContract;
}

/**
 * Startup wiring: enforces the persistent-storage contract in production only,
 * and is a no-op in development and test. Call this strictly BEFORE opening the
 * database so a rejected startup never creates a SQLite file.
 */
export function enforcePersistentStorageContract(
  config: BootstrapStorageConfig,
  options: EnforcePersistentStorageOptions = {}
): void {
  if (config.environment !== "production") return;
  assertPersistentStorage({
    databasePath: config.database.path,
    ...(options.env ? { env: options.env } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.contract ? { contract: options.contract } : {})
  });
}
