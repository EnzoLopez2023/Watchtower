import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../server/config.js";

const PRODUCTION_IDENTITY = {
  NODE_ENV: "production",
  AZURE_AD_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
  AZURE_AD_CLIENT_ID: "55bf92db-2cec-4e65-ab0d-71bee90d7494",
  AZURE_AD_AUDIENCE: "api://55bf92db-2cec-4e65-ab0d-71bee90d7494",
  ADMIN_OID: "d6c36f6e-054c-45b8-9468-16c208628814",
  MARQUEE_BASE_URL: "https://marquee.example",
  MARQUEE_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
  MARQUEE_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  MARQUEE_SCOPE: "api://marquee/.default"
};

test("production fixes the SQLite authority to /home/data/watchtower.db", () => {
  const config = loadConfig(PRODUCTION_IDENTITY);
  assert.equal(config.database.path, "/home/data/watchtower.db");
  assert.throws(() =>
    loadConfig({ ...PRODUCTION_IDENTITY, DB_PATH: "/tmp/not-production.db" })
  );
});

test("production fails closed without Entra or Marquee workload identity", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /AZURE_AD/);
  const withoutScope: NodeJS.ProcessEnv = { ...PRODUCTION_IDENTITY };
  delete withoutScope.MARQUEE_SCOPE;
  assert.throws(() => loadConfig(withoutScope), /MARQUEE/);
});

test("SQLite busy timeout remains bounded", () => {
  assert.throws(() =>
    loadConfig({ NODE_ENV: "test", SQLITE_BUSY_TIMEOUT_MS: "60000" })
  );
  assert.equal(
    loadConfig({ NODE_ENV: "test", SQLITE_BUSY_TIMEOUT_MS: "750" }).database.busyTimeoutMs,
    750
  );
});
