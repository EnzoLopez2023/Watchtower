import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../server/config.js";

const PRODUCTION: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DB_PATH: "/home/data/watchtower.db",
  AZURE_AD_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
  AZURE_AD_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  AZURE_AD_AUDIENCE: "api://watchtower",
  ADMIN_OID: "d6c36f6e-054c-45b8-9468-16c208628814",
  MARQUEE_BASE_URL: "https://marquee.example",
  MARQUEE_SCOPE: "api://marquee/.default"
};

const DEVELOPMENT: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DB_PATH: "./.scratch/wt/tmp/config.db"
};

function production(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...PRODUCTION, ...overrides };
}

test("production requires an HTTPS Marquee base URL", () => {
  assert.throws(
    () => loadConfig(production({ MARQUEE_BASE_URL: "http://marquee.example" })),
    /MARQUEE_BASE_URL must use HTTPS in production/
  );
  const config = loadConfig(production());
  assert.equal(config.marquee.baseUrl?.protocol, "https:");
});

test("development keeps plain HTTP available for local contract tests", () => {
  const config = loadConfig({
    ...DEVELOPMENT,
    MARQUEE_BASE_URL: "http://127.0.0.1:4310",
    MARQUEE_SCOPE: "api://marquee/.default"
  });
  assert.equal(config.marquee.baseUrl?.protocol, "http:");
  assert.equal(config.marquee.baseUrl?.hostname, "127.0.0.1");

  const testEnvironment = loadConfig({
    ...DEVELOPMENT,
    NODE_ENV: "test",
    MARQUEE_BASE_URL: "http://localhost:4310"
  });
  assert.equal(testEnvironment.marquee.baseUrl?.protocol, "http:");
});

test("a non-HTTP scheme is rejected in every environment", () => {
  assert.throws(
    () => loadConfig({ ...DEVELOPMENT, MARQUEE_BASE_URL: "file:///etc/passwd" }),
    /MARQUEE_BASE_URL must use HTTP or HTTPS/
  );
});

test("production rejects unresolved Key Vault references before they become credentials", () => {
  assert.throws(
    () =>
      loadConfig(
        production({
          UNIFI_INGEST_TOKEN:
            "@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/UNIFI-INGEST-TOKEN/)"
        })
      ),
    /Unresolved Azure Key Vault references: UNIFI_INGEST_TOKEN/
  );
});

test("the Marquee scope must be an application scope ending in /.default", () => {
  for (const scope of [
    "api://marquee",
    "api://marquee/.default/extra",
    ".default",
    "/.default",
    "api:///.default",
    "marquee/.default",
    "api://marquee/user_impersonation"
  ]) {
    assert.throws(
      () => loadConfig({ ...DEVELOPMENT, MARQUEE_SCOPE: scope }),
      /MARQUEE_SCOPE must be an application scope/,
      `expected ${scope} to be rejected`
    );
  }

  for (const scope of ["api://marquee/.default", "https://marquee.example/.default"]) {
    assert.equal(
      loadConfig({ ...DEVELOPMENT, MARQUEE_SCOPE: scope }).marquee.scope,
      scope,
      `expected ${scope} to be accepted`
    );
  }
});

test("production rejects a scope that is not an application scope", () => {
  assert.throws(
    () => loadConfig(production({ MARQUEE_SCOPE: "api://marquee/Media.Read" })),
    /MARQUEE_SCOPE must be an application scope/
  );
});

test("no static Marquee credential can be configured", () => {
  for (const key of [
    "MARQUEE_TOKEN",
    "MARQUEE_API_KEY",
    "MARQUEE_API_TOKEN",
    "MARQUEE_ACCESS_TOKEN",
    "MARQUEE_BEARER_TOKEN",
    "MARQUEE_SHARED_SECRET"
  ]) {
    assert.throws(
      () => loadConfig({ ...DEVELOPMENT, [key]: "static-value" }),
      new RegExp(`${key} is not supported`),
      `expected ${key} to be rejected rather than silently ignored`
    );
  }
});

test("production forbids a Marquee client secret so managed identity is the only path", () => {
  assert.throws(
    () => loadConfig(production({ MARQUEE_CLIENT_SECRET: "s3cret" })),
    /MARQUEE_CLIENT_SECRET is not permitted in production/
  );
  // Local development may still use a confidential client against a test tenant.
  const development = loadConfig({
    ...DEVELOPMENT,
    MARQUEE_CLIENT_SECRET: "s3cret",
    MARQUEE_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    MARQUEE_CLIENT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  });
  assert.equal(development.marquee.clientSecret, "s3cret");
});

test("a complete production environment still loads", () => {
  const config = loadConfig(production());
  assert.equal(config.environment, "production");
  assert.equal(config.marquee.scope, "api://marquee/.default");
  assert.equal(config.marquee.clientSecret, undefined);
});

// ── Credential selection ─────────────────────────────────────────────────────

/** The credential is private to the client; reaching it is the only way to
 *  prove which branch was taken without making a network call. */
function credentialOf(client: unknown): unknown {
  return (client as { options?: { credential?: unknown } }).options?.credential;
}

test("production resolves Marquee through managed identity, not a service principal", async () => {
  const { ClientSecretCredential, ManagedIdentityCredential } = await import("@azure/identity");
  const { createMediaHealthClient } = await import("../../server/clients/marqueeMediaHealth.js");

  const config = loadConfig(production());
  assert.equal(config.marquee.clientSecret, undefined);
  assert.equal(config.marquee.clientId, undefined);

  const credential = credentialOf(createMediaHealthClient(config.marquee));
  assert.ok(
    credential instanceof ManagedIdentityCredential,
    "production must acquire its Marquee token from the system-assigned workload identity"
  );
  assert.ok(!(credential instanceof ClientSecretCredential));
});

test("development may still use a confidential client against a test tenant", async () => {
  const { ClientSecretCredential } = await import("@azure/identity");
  const { createMediaHealthClient } = await import("../../server/clients/marqueeMediaHealth.js");

  const config = loadConfig({
    ...DEVELOPMENT,
    MARQUEE_BASE_URL: "http://127.0.0.1:4310",
    MARQUEE_TENANT_ID: "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    MARQUEE_CLIENT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    MARQUEE_SCOPE: "api://marquee/.default",
    MARQUEE_CLIENT_SECRET: "s3cret"
  });
  const credential = credentialOf(createMediaHealthClient(config.marquee));
  assert.ok(credential instanceof ClientSecretCredential);
});

test("a local confidential client must include its tenant and client id", () => {
  assert.throws(
    () =>
      loadConfig({
        ...DEVELOPMENT,
        MARQUEE_BASE_URL: "http://127.0.0.1:4310",
        MARQUEE_SCOPE: "api://marquee/.default",
        MARQUEE_CLIENT_SECRET: "s3cret"
      }),
    /MARQUEE_TENANT_ID and MARQUEE_CLIENT_ID are required/
  );
});

test("an incompletely configured Marquee never falls back to an unauthenticated call", async () => {
  const { createMediaHealthClient } = await import("../../server/clients/marqueeMediaHealth.js");
  const config = loadConfig({ ...DEVELOPMENT, MARQUEE_BASE_URL: "http://127.0.0.1:4310" });
  const client = createMediaHealthClient(config.marquee);
  await assert.rejects(() => client.get(), /Marquee workload identity is not configured/);
});

test("no application-wide shared token may be configured", () => {
  for (const key of ["WATCHTOWER_API_TOKEN", "WATCHTOWER_SHARED_TOKEN", "AGENT_INGEST_TOKEN"]) {
    assert.throws(
      () => loadConfig({ ...DEVELOPMENT, [key]: "static-value" }),
      new RegExp(`${key} is not supported`),
      `expected ${key} to be rejected rather than becoming an auth fallback`
    );
  }
});

test("per-surface service secrets remain supported", () => {
  const config = loadConfig({
    ...DEVELOPMENT,
    MOBILE_API_TOKEN: "mobile",
    UNIFI_INGEST_TOKEN: "unifi",
    UPS_INGEST_TOKEN: "ups"
  });

  assert.equal(config.serviceTokens.mobile, "mobile");
  assert.equal(config.serviceTokens.unifi, "unifi");
  assert.equal(config.serviceTokens.ups, "ups");
  // Distinct secrets, never one shared value.
  assert.notEqual(config.serviceTokens.mobile, config.serviceTokens.unifi);
});

test("critical APNs alerts are opt-in and sandbox remains wire-compatible", () => {
  assert.equal(loadConfig(DEVELOPMENT).apns.criticalAlerts, false);
  assert.equal(
    loadConfig({ ...DEVELOPMENT, APNS_CRITICAL_ALERTS: "true" }).apns.criticalAlerts,
    true
  );
  assert.equal(
    loadConfig({ ...DEVELOPMENT, APNS_ENV: "sandbox" }).apns.environment,
    "development"
  );
});
