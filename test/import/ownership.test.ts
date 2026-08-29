import { strict as assert } from "node:assert";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_OWNED_ROW_TOTAL,
  EXPECTED_OWNED_TABLES,
  EXPECTED_OWNED_TABLE_COUNT,
  NEVER_COPIED_SHARED_TABLES,
  OWNED_API_PATH_PREFIXES,
  OWNED_VIEW_IDS,
  isOwnedApiPath,
  isOwnedViewId,
  loadOwnershipContract
} from "../../lib/db/import/ownership.js";
import { ImportError } from "../../lib/db/import/errors.js";
import { makeScratchDir, removeScratchDir } from "./fixtures.js";

const BASE_MANIFEST = {
  manifestVersion: 1,
  sourceBaseline: {
    repository: "EnzoLopez2023/Hearth",
    version: "2.13.2",
    build: 172,
    commit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871",
    tree: "62cbd35861c511f7c17187c875d19ee6e353b80d",
    imageDigest: "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140",
    database: {
      backupBytes: 950947840,
      backupSha256: "dc9fb47d269b339a3dcae37279dc3116f37a0635728a2d2b2ac2c511811a5807",
      backupCreatedUtc: "2026-08-28T05:36:25.317Z"
    }
  },
  sharedTableDispositions: {
    hearth_users: "transform",
    hearth_permissions: "transform",
    audit_log: "partition",
    hearth_index: "do not migrate"
  },
  products: [{ name: "Watchtower", tables: [...EXPECTED_OWNED_TABLES], views: [...OWNED_VIEW_IDS] }]
};

type MutableManifest = typeof BASE_MANIFEST & {
  products: { name: string; tables: string[]; views: string[] }[];
};

function writeManifest(directory: string, mutate: (manifest: MutableManifest) => void): string {
  const manifest = structuredClone(BASE_MANIFEST) as MutableManifest;
  mutate(manifest);
  const path = join(directory, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

test("the reviewed contract is exactly 54 unique tables and 11 views", () => {
  assert.equal(EXPECTED_OWNED_TABLES.length, EXPECTED_OWNED_TABLE_COUNT);
  assert.equal(EXPECTED_OWNED_TABLES.length, 54);
  assert.equal(new Set(EXPECTED_OWNED_TABLES).size, 54);
  assert.equal(OWNED_VIEW_IDS.length, 11);
  assert.equal(EXPECTED_OWNED_ROW_TOTAL, 2_723_313);
});

test("shared Hearth tables are never in the owned table set", () => {
  for (const shared of NEVER_COPIED_SHARED_TABLES) {
    assert.ok(!EXPECTED_OWNED_TABLES.includes(shared), `${shared} must not be copied`);
  }
  assert.deepEqual([...NEVER_COPIED_SHARED_TABLES].sort(), [
    "audit_log",
    "hearth_index",
    "hearth_permissions",
    "hearth_users"
  ]);
});

test("owned API prefixes match Watchtower route modules only", () => {
  assert.ok(isOwnedApiPath("/api/power/items/34"));
  assert.ok(isOwnedApiPath("/api/unifi/logs/flows"));
  assert.ok(isOwnedApiPath("/api/mobile/register-device"));
  assert.ok(isOwnedApiPath("/api/admin/logs"));
  assert.ok(isOwnedApiPath("/api/network-observer/ingest"));

  assert.ok(!isOwnedApiPath("/api/admin/permissions"));
  assert.ok(!isOwnedApiPath("/api/recipes/53"));
  assert.ok(!isOwnedApiPath("/api/plex/duplicates/delete"));
  assert.ok(!isOwnedApiPath(null));
  assert.ok(OWNED_API_PATH_PREFIXES.every((prefix) => prefix.startsWith("/api/")));
});

test("owned view ids gate audit ownership", () => {
  assert.ok(isOwnedViewId("ip-migration"));
  assert.ok(isOwnedViewId("protect"));
  assert.ok(!isOwnedViewId("dashboard"));
  assert.ok(!isOwnedViewId("plex-command-center"));
  assert.ok(!isOwnedViewId(null));
});

test("loadOwnershipContract accepts a matching manifest", () => {
  const directory = makeScratchDir("ownership-ok");
  try {
    const contract = loadOwnershipContract(writeManifest(directory, () => {}));
    assert.equal(contract.ownedTables.length, 54);
    assert.equal(contract.expectedOwnedRowTotal, 2_723_313);
    assert.equal(contract.sourceBaseline.build, 172);
    assert.equal(contract.sourceBaseline.backupBytes, 950947840);
  } finally {
    removeScratchDir(directory);
  }
});

test("loadOwnershipContract rejects table ownership drift", () => {
  const directory = makeScratchDir("ownership-drift");
  try {
    const path = writeManifest(directory, (manifest) => {
      manifest.products = [{ ...manifest.products[0]!, tables: [...EXPECTED_OWNED_TABLES.slice(0, 53), "recipes"] }];
    });
    assert.throws(
      () => loadOwnershipContract(path),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_OWNERSHIP_DRIFT"
    );
  } finally {
    removeScratchDir(directory);
  }
});

test("loadOwnershipContract rejects a wrong table count", () => {
  const directory = makeScratchDir("ownership-count");
  try {
    const path = writeManifest(directory, (manifest) => {
      manifest.products = [{ ...manifest.products[0]!, tables: [...EXPECTED_OWNED_TABLES.slice(0, 53)] }];
    });
    assert.throws(
      () => loadOwnershipContract(path),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_OWNERSHIP_DRIFT"
    );
  } finally {
    removeScratchDir(directory);
  }
});

test("loadOwnershipContract rejects view drift", () => {
  const directory = makeScratchDir("ownership-views");
  try {
    const path = writeManifest(directory, (manifest) => {
      manifest.products = [{ ...manifest.products[0]!, views: [...OWNED_VIEW_IDS.slice(0, 10), "recipe-manager"] }];
    });
    assert.throws(
      () => loadOwnershipContract(path),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_OWNERSHIP_DRIFT"
    );
  } finally {
    removeScratchDir(directory);
  }
});

test("loadOwnershipContract rejects a missing Watchtower product", () => {
  const directory = makeScratchDir("ownership-missing");
  try {
    const path = writeManifest(directory, (manifest) => {
      manifest.products = [];
    });
    assert.throws(
      () => loadOwnershipContract(path),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_INVALID"
    );
  } finally {
    removeScratchDir(directory);
  }
});

test("loadOwnershipContract rejects unreadable and malformed manifests", () => {
  const directory = makeScratchDir("ownership-bad");
  try {
    assert.throws(
      () => loadOwnershipContract(join(directory, "does-not-exist.json")),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_INVALID"
    );
    const broken = join(directory, "broken.json");
    writeFileSync(broken, "{not json");
    assert.throws(
      () => loadOwnershipContract(broken),
      (error: unknown) => error instanceof ImportError && error.code === "MANIFEST_INVALID"
    );
  } finally {
    removeScratchDir(directory);
  }
});
