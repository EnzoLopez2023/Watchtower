import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackup, BACKUP_MANIFEST_FILE, BACKUP_SNAPSHOT_FILE } from "../../lib/recovery/backup.js";
import { uploadBundleWithReadback } from "../../lib/recovery/offhost.js";
import {
  FORBIDDEN_CREDENTIAL_VARIABLES,
  assertManagedIdentityOnlyEnvironment,
  blobUrl,
  readBlobDigest,
  uploadBlob,
  validateBlobName,
  validateStorageAccount,
  validateStorageContainer
} from "../../lib/recovery/managedIdentityBlob.js";
import { RecoveryError } from "../../lib/recovery/errors.js";
import { buildAuthorityFixture, makeScratchDir, removeScratchDir } from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

/** In-memory Blob endpoint used instead of a real storage account. */
function fakeBlobService(options: { corruptOnRead?: boolean; failStatus?: number } = {}): {
  fetchImpl: typeof fetch;
  objects: Map<string, Buffer>;
  authorizations: string[];
} {
  const objects = new Map<string, Buffer>();
  const authorizations: string[] = [];

  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authorizations.push(headers.authorization ?? "");

    if (options.failStatus !== undefined) {
      return new Response(null, {
        status: options.failStatus,
        headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" }
      });
    }

    if ((init?.method ?? "GET") === "PUT") {
      assert.equal(headers["x-ms-blob-type"], "BlockBlob");
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      objects.set(url, body);
      return new Response(null, { status: 201, headers: { etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"` } });
    }

    const stored = objects.get(url);
    if (!stored) return new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } });
    const body = options.corruptOnRead ? Buffer.concat([stored, Buffer.from([0x00])]) : stored;
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;

  return { fetchImpl, objects, authorizations };
}

test("shared-secret credentials are rejected outright", () => {
  assert.ok(FORBIDDEN_CREDENTIAL_VARIABLES.length >= 6);
  assertManagedIdentityOnlyEnvironment({});

  for (const name of FORBIDDEN_CREDENTIAL_VARIABLES) {
    assert.throws(
      () => assertManagedIdentityOnlyEnvironment({ [name]: "secret" }),
      (error: unknown) =>
        error instanceof RecoveryError && error.code === "STORAGE_SHARED_CREDENTIAL_REJECTED",
      `${name} must be rejected`
    );
  }

  // Empty values are ignored, so an unset-but-declared variable is fine.
  assertManagedIdentityOnlyEnvironment({ AZURE_STORAGE_ACCOUNT_KEY: "   " });
});

test("storage account, container and blob names are validated", () => {
  assert.equal(validateStorageAccount("strecoverywkhiw2g4hwik4"), "strecoverywkhiw2g4hwik4");
  for (const bad of ["", "AB", "UPPERCASE", "has-dash", "x".repeat(25)]) {
    assert.throws(
      () => validateStorageAccount(bad),
      (error: unknown) => error instanceof RecoveryError && error.code === "BLOB_CONFIGURATION_INVALID"
    );
  }

  assert.equal(validateStorageContainer("watchtower"), "watchtower");
  for (const bad of ["", "a", "-leading", "trailing-", "Upper"]) {
    assert.throws(
      () => validateStorageContainer(bad),
      (error: unknown) => error instanceof RecoveryError && error.code === "BLOB_CONFIGURATION_INVALID"
    );
  }

  assert.equal(validateBlobName("bundle/watchtower.sqlite3"), "bundle/watchtower.sqlite3");
  for (const bad of ["", "/leading", "trailing/", "a\\b", "a//b", "../escape", "./here", "bad\u0000name"]) {
    assert.throws(
      () => validateBlobName(bad),
      (error: unknown) =>
        error instanceof RecoveryError &&
        (error.code === "BLOB_NAME_INVALID" || error.code === "BLOB_CONFIGURATION_INVALID"),
      `${JSON.stringify(bad)} must be rejected`
    );
  }
});

test("blobUrl encodes each path segment", () => {
  assert.equal(
    blobUrl("acct", "cont", "2026/bundle id/watchtower.sqlite3"),
    "https://acct.blob.core.windows.net/cont/2026/bundle%20id/watchtower.sqlite3"
  );
});

test("upload and read-back use only a bearer token from the token provider", async () => {
  const directory = scratch("blob-upload");
  const file = join(directory, "payload.bin");
  const payload = Buffer.from("watchtower snapshot bytes");
  writeFileSync(file, payload);

  const service = fakeBlobService();
  const upload = await uploadBlob({
    account: "acct",
    container: "cont",
    blobName: "bundle/payload.bin",
    filePath: file,
    env: {},
    tokenProvider: async () => "managed-identity-token",
    fetchImpl: service.fetchImpl
  });

  assert.equal(upload.bytes, payload.byteLength);
  assert.equal(upload.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.ok(service.authorizations.every((value) => value === "Bearer managed-identity-token"));

  const readback = await readBlobDigest({
    account: "acct",
    container: "cont",
    blobName: "bundle/payload.bin",
    env: {},
    tokenProvider: async () => "managed-identity-token",
    fetchImpl: service.fetchImpl
  });
  assert.equal(readback.bytes, upload.bytes);
  assert.equal(readback.sha256, upload.sha256);
});

test("a failed Blob request surfaces the service error code", async () => {
  const directory = scratch("blob-failure");
  const file = join(directory, "payload.bin");
  writeFileSync(file, "x");

  const service = fakeBlobService({ failStatus: 403 });
  await assert.rejects(
    uploadBlob({
      account: "acct",
      container: "cont",
      blobName: "bundle/payload.bin",
      filePath: file,
      env: {},
      tokenProvider: async () => "token",
      fetchImpl: service.fetchImpl
    }),
    (error: unknown) =>
      error instanceof RecoveryError &&
      error.code === "BLOB_REQUEST_FAILED" &&
      error.details.status === 403 &&
      error.details.serviceCode === "AuthorizationPermissionMismatch"
  );
});

test("uploadBundleWithReadback verifies both objects against the bundle", async () => {
  const directory = scratch("blob-bundle");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const service = fakeBlobService();
  const result = await uploadBundleWithReadback({
    bundleDir: created.bundleDir,
    account: "acct",
    container: "cont",
    prefix: "watchtower",
    env: {},
    tokenProvider: async () => "token",
    fetchImpl: service.fetchImpl
  });

  assert.ok(result.verified);
  assert.equal(result.bundleId, created.manifest.bundleId);
  assert.equal(result.snapshot.upload.sha256, created.manifest.database.sha256);
  assert.equal(result.snapshot.readback.sha256, created.manifest.database.sha256);

  const keys = [...service.objects.keys()].sort();
  assert.equal(keys.length, 2);
  assert.ok(keys.some((key) => key.endsWith(`/watchtower/${created.manifest.bundleId}/${BACKUP_SNAPSHOT_FILE}`)));
  assert.ok(keys.some((key) => key.endsWith(`/watchtower/${created.manifest.bundleId}/${BACKUP_MANIFEST_FILE}`)));

  const storedSnapshot = service.objects.get(
    keys.find((key) => key.endsWith(BACKUP_SNAPSHOT_FILE)) as string
  ) as Buffer;
  assert.deepEqual(storedSnapshot, readFileSync(created.snapshotPath));
});

test("a read-back that does not match the upload fails the run", async () => {
  const directory = scratch("blob-readback-mismatch");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const service = fakeBlobService({ corruptOnRead: true });
  await assert.rejects(
    uploadBundleWithReadback({
      bundleDir: created.bundleDir,
      account: "acct",
      container: "cont",
      env: {},
      tokenProvider: async () => "token",
      fetchImpl: service.fetchImpl
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BLOB_READBACK_MISMATCH"
  );
});

test("off-host upload refuses to run with a shared secret in the environment", async () => {
  const directory = scratch("blob-secret");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const service = fakeBlobService();
  await assert.rejects(
    uploadBundleWithReadback({
      bundleDir: created.bundleDir,
      account: "acct",
      container: "cont",
      env: { AZURE_STORAGE_SAS_TOKEN: "sv=2023-11-03&sig=secret" },
      tokenProvider: async () => "token",
      fetchImpl: service.fetchImpl
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "STORAGE_SHARED_CREDENTIAL_REJECTED"
  );
});
