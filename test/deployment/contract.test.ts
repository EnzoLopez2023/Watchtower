import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEPLOYMENT_CONTRACT,
  PRODUCTION_DATABASE_PATH,
  parseDeploymentContract
} from "../../lib/deployment/index.js";
import { loadConfig } from "../../server/config.js";

const CONTRACT_JSON_PATH = new URL(
  "../../lib/deployment/deployment.contract.json",
  import.meta.url
);

test("the contract names the exact env var, mount, data dir, and authority path", () => {
  assert.equal(DEPLOYMENT_CONTRACT.schema, "watchtower.deployment.contract.v3");
  assert.equal(DEPLOYMENT_CONTRACT.platform, "azure-app-service-linux");
  assert.deepEqual(DEPLOYMENT_CONTRACT.containerRegistry, {
    mode: "shared-existing",
    name: "acrenzolopez01",
    loginServer: "acrenzolopez01.azurecr.io",
    dedicatedRegistryAllowed: false
  });
  const storage = DEPLOYMENT_CONTRACT.persistentStorage;
  assert.equal(storage.requiredEnv.name, "WEBSITES_ENABLE_APP_SERVICE_STORAGE");
  assert.equal(storage.requiredEnv.value, "true");
  assert.equal(storage.mountPoint, "/home");
  assert.equal(storage.dataDirectory, "/home/data");
  assert.equal(storage.databasePath, "/home/data/watchtower.db");
  assert.equal(PRODUCTION_DATABASE_PATH, "/home/data/watchtower.db");
});

test("the checked-in JSON artifact is the source the typed loader parses", () => {
  const raw: unknown = JSON.parse(readFileSync(CONTRACT_JSON_PATH, "utf8"));
  // The machine-readable file on disk must round-trip to the same frozen object
  // the runtime consumes, so IaC reading the JSON sees exactly what runs.
  assert.deepEqual(parseDeploymentContract(raw), DEPLOYMENT_CONTRACT);
});

test("the contract object is deeply frozen so no consumer can mutate it", () => {
  assert.ok(Object.isFrozen(DEPLOYMENT_CONTRACT));
  assert.ok(Object.isFrozen(DEPLOYMENT_CONTRACT.containerRegistry));
  assert.ok(Object.isFrozen(DEPLOYMENT_CONTRACT.persistentStorage));
  assert.ok(Object.isFrozen(DEPLOYMENT_CONTRACT.persistentStorage.requiredEnv));
});

const VALID_EVIDENCE = {
  deploymentProfile: "sqlite-one-worker",
  dataStorageMode: "persistent",
  numberOfWorkers: 1,
  alwaysOn: true,
  containerPort: 3000,
  healthCheckPath: "/api/live",
  readinessPath: "/api/ready",
  forbiddenImageVolumePrefix: "/home"
};
const VALID_REGISTRY = {
  mode: "shared-existing",
  name: "acrenzolopez01",
  loginServer: "acrenzolopez01.azurecr.io",
  dedicatedRegistryAllowed: false
};

test("a malformed contract document fails loudly at parse time", () => {
  assert.throws(() => parseDeploymentContract({}), /persistentStorage must be an object/);
  assert.throws(
    () =>
      parseDeploymentContract({
        schema: "x",
        platform: "y",
        containerRegistry: VALID_REGISTRY,
        persistentStorage: {
          requiredEnv: { name: "N", value: "true" },
          mountPoint: "/home",
          dataDirectory: "/home/data",
          databasePath: "",
          backupRoot: "/home/data/backups/watchtower",
          journalMode: { name: "SQLITE_JOURNAL_MODE", value: "DELETE" }
        },
        evidence: VALID_EVIDENCE
      }),
    /databasePath must be a non-empty string/
  );
  assert.throws(() => parseDeploymentContract({
    schema: "x",
    platform: "y",
    containerRegistry: VALID_REGISTRY,
    persistentStorage: {
      requiredEnv: { name: "N", value: "true" },
      mountPoint: "/home",
      dataDirectory: "/home/data",
      databasePath: "/home/data/watchtower.db",
      backupRoot: "/home/data/backups/watchtower",
      journalMode: { name: "SQLITE_JOURNAL_MODE", value: "DELETE" }
    },
    evidence: { ...VALID_EVIDENCE, numberOfWorkers: 2.5 }
  }), /numberOfWorkers must be a positive integer/);
  assert.throws(() => parseDeploymentContract({
    schema: "x",
    platform: "y",
    containerRegistry: VALID_REGISTRY,
    persistentStorage: {
      requiredEnv: { name: "N", value: "true" },
      mountPoint: "/home",
      dataDirectory: "/home/data",
      databasePath: "/home/data/watchtower.db",
      backupRoot: "/home/data/backups/watchtower",
      journalMode: { name: "SQLITE_JOURNAL_MODE", value: "DELETE" }
    },
    evidence: { ...VALID_EVIDENCE, alwaysOn: "yes" }
  }), /alwaysOn must be a boolean/);
});

test("production config resolves its DB path to the contract authority", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    DB_PATH: PRODUCTION_DATABASE_PATH,
    AZURE_AD_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    AZURE_AD_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    AZURE_AD_AUDIENCE: "api://watchtower",
    ADMIN_OID: "d6c36f6e-054c-45b8-9468-16c208628814",
    MARQUEE_BASE_URL: "https://marquee.example",
    MARQUEE_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    MARQUEE_CLIENT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    MARQUEE_SCOPE: "api://marquee/.default"
  });
  assert.equal(config.database.path, DEPLOYMENT_CONTRACT.persistentStorage.databasePath);
});
