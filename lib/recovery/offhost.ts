/**
 * Off-host bundle upload with mandatory read-back verification, and disposable
 * restore.
 */

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { RecoveryError } from "./errors.js";
import { assertSafeDestination, sha256File } from "./paths.js";
import {
  BACKUP_MANIFEST_FILE,
  readBackupManifest,
  verifyBackup,
  type BackupManifest,
  type VerifyBackupResult
} from "./backup.js";
import {
  readBlobDigest,
  uploadBlob,
  type BlobClientOptions,
  type BlobReadbackResult,
  type BlobUploadResult
} from "./managedIdentityBlob.js";
import {
  readSchemaVersionIdentity,
  readTableSnapshots,
  runSnapshotChecks,
  type SnapshotChecks
} from "./snapshot.js";

export interface OffhostUploadResult {
  readonly bundleId: string;
  readonly snapshot: { readonly upload: BlobUploadResult; readonly readback: BlobReadbackResult };
  readonly manifest: { readonly upload: BlobUploadResult; readonly readback: BlobReadbackResult };
  readonly verified: boolean;
}

/**
 * Uploads a verified bundle to private app-owned Blob Storage and reads both
 * objects back, asserting identical bytes and SHA-256.
 */
export async function uploadBundleWithReadback(
  options: BlobClientOptions & {
    readonly bundleDir: string;
    readonly prefix?: string;
  }
): Promise<OffhostUploadResult> {
  const bundleDir = resolve(options.bundleDir);
  const verification = await verifyBackup({ bundleDir });
  const manifest: BackupManifest = verification.manifest;

  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const base = prefix === "" ? manifest.bundleId : `${prefix}/${manifest.bundleId}`;

  const files: { blobName: string; filePath: string }[] = [
    { blobName: `${base}/${manifest.database.file}`, filePath: join(bundleDir, manifest.database.file) },
    { blobName: `${base}/${BACKUP_MANIFEST_FILE}`, filePath: join(bundleDir, BACKUP_MANIFEST_FILE) }
  ];

  const results: { upload: BlobUploadResult; readback: BlobReadbackResult }[] = [];
  for (const file of files) {
    const upload = await uploadBlob({ ...options, blobName: file.blobName, filePath: file.filePath });
    const readback = await readBlobDigest({ ...options, blobName: file.blobName });
    if (readback.bytes !== upload.bytes || readback.sha256 !== upload.sha256) {
      throw new RecoveryError("BLOB_READBACK_MISMATCH", `Read-back of ${file.blobName} does not match the upload`, {
        blobName: file.blobName,
        uploadedBytes: upload.bytes,
        readBytes: readback.bytes,
        uploadedSha256: upload.sha256,
        readSha256: readback.sha256
      });
    }
    results.push({ upload, readback });
  }

  const [snapshotResult, manifestResult] = results;
  if (snapshotResult === undefined || manifestResult === undefined) {
    throw new RecoveryError("BLOB_REQUEST_FAILED", "Off-host upload did not complete both bundle objects");
  }
  if (snapshotResult.upload.sha256 !== manifest.database.sha256) {
    throw new RecoveryError("BLOB_READBACK_MISMATCH", "Uploaded snapshot digest does not match the bundle manifest", {
      manifestSha256: manifest.database.sha256,
      uploadedSha256: snapshotResult.upload.sha256
    });
  }

  return {
    bundleId: manifest.bundleId,
    snapshot: snapshotResult,
    manifest: manifestResult,
    verified: true
  };
}

export interface RestoreResult {
  readonly destination: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly checks: SnapshotChecks;
  readonly tableCountsMatch: boolean;
  readonly identityMatches: boolean;
  readonly sourceVerification: VerifyBackupResult;
  readonly durationMs: number;
}

/**
 * Restores a verified bundle into a disposable destination and re-verifies it.
 * The destination must be new and inside an explicitly supplied root; it can
 * never be the live authority path.
 */
export async function restoreBundle(options: {
  readonly bundleDir: string;
  readonly destination: string;
  readonly allowedRoot: string;
  readonly protectedPaths?: readonly string[];
  readonly busyTimeoutMs?: number;
  readonly allowInsideGitWorktree?: boolean;
}): Promise<RestoreResult> {
  const startedAt = process.hrtime.bigint();
  const bundleDir = resolve(options.bundleDir);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;

  const sourceVerification = await verifyBackup({ bundleDir, busyTimeoutMs });
  const manifest = await readBackupManifest(bundleDir);
  const snapshotPath = join(bundleDir, manifest.database.file);

  const destination = assertSafeDestination({
    destination: options.destination,
    allowedRoot: options.allowedRoot,
    protectedPaths: [...(options.protectedPaths ?? []), manifest.database.sourcePath, snapshotPath],
    allowInsideGitWorktree: options.allowInsideGitWorktree,
    mustNotExist: true
  });

  await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
  await copyFile(snapshotPath, destination);

  try {
    const bytes = (await stat(destination)).size;
    const sha256 = await sha256File(destination);
    if (bytes !== manifest.database.bytes || sha256 !== manifest.database.sha256) {
      throw new RecoveryError("RESTORE_VERIFICATION_FAILED", "Restored file does not match the bundle manifest", {
        expectedBytes: manifest.database.bytes,
        actualBytes: bytes,
        expectedSha256: manifest.database.sha256,
        actualSha256: sha256
      });
    }

    const database = new Database(destination, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
    let checks: SnapshotChecks;
    let identityMatches: boolean;
    let tableCountsMatch: boolean;
    try {
      database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      database.pragma("foreign_keys = ON");
      checks = runSnapshotChecks(database);
      identityMatches = readSchemaVersionIdentity(database).schemaSha256 === manifest.database.identity.schemaSha256;
      const actual = new Map(readTableSnapshots(database).map((table) => [table.name, table.rowCount]));
      tableCountsMatch = manifest.database.tables.every((table) => actual.get(table.name) === table.rowCount);
    } finally {
      database.close();
    }

    if (!identityMatches || !tableCountsMatch) {
      throw new RecoveryError("RESTORE_VERIFICATION_FAILED", "Restored database does not match the bundle manifest", {
        identityMatches,
        tableCountsMatch
      });
    }

    return {
      destination,
      bytes,
      sha256,
      checks,
      tableCountsMatch,
      identityMatches,
      sourceVerification,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
    };
  } catch (error) {
    if (existsSync(destination)) await rm(destination, { force: true });
    throw error;
  }
}
