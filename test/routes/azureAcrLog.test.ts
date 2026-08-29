import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AppConfig } from "../../server/config.js";
import type { AzureArmClients } from "../../server/clients/azure.js";
import { createAzureCache } from "../../server/clients/azure.js";
import { createAzureRouter } from "../../server/routes/features/azure.js";
import { errorHandler } from "../../server/http/errors.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppRole } from "../../lib/db/repositories/identityRepository.js";
import type { TokenCredential } from "@azure/identity";
import {
  fetchAcrRunLog,
  isTrustedAcrLogUrl,
  sanitizeAcrLogText,
  ACR_LOG_MAX_BYTES
} from "../../server/clients/acrLogProxy.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A realistic replayable SAS URL. Its signature value is unique so a raw string
// scan can prove it never reaches the client.
const SAS_URL =
  "https://myacct.blob.core.windows.net/logs/ca123.txt" +
  "?sv=2021-08-06&st=2026-01-01T00%3A00%3A00Z&se=2026-01-02T00%3A00%3A00Z" +
  "&sr=b&sp=r&sig=UNIQUESIGVALUE1234567890%3D%3D";

// A build log body that itself embeds a secret-bearing blob URL, so the tests
// prove the tail/proxy sanitizes material that appears *inside* the log too.
const RUN_LOG =
  "Step 1/3 : FROM node:18\n" +
  "Fetching layer https://myacct.blob.core.windows.net/layers/abc.tar?sv=2021&sig=LAYERSIGSECRET==\n" +
  "Successfully built image\n";

const LOG_PATH = "/api/azure/acr/rg-test/myreg/runs/ca123/log";
const DETAIL_PATH = "/api/azure/acr/rg-test/myreg/runs/ca123";

// ── Config / credential / client stubs ───────────────────────────────────────

function makeConfig(over: { enabled?: boolean; requestTimeoutMs?: number } = {}): AppConfig {
  return {
    environment: "test",
    port: 3000,
    database: { path: ":memory:", busyTimeoutMs: 5000 },
    entra: { tenantId: "t", clientId: "c", audience: "a", configured: false },
    corsOrigins: [],
    serviceTokens: {},
    azure: {
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      tenantId: "00000000-0000-0000-0000-000000000002",
      defaultResourceGroup: "rg-test",
      requestTimeoutMs: over.requestTimeoutMs ?? 5000,
      enabled: over.enabled !== false,
    },
    monitoringArchive: { container: "c", settleHours: 0, intervalHours: 1, maxDaysPerRun: 1, leaseMs: 60000, enabled: false },
    alerts: { pollSeconds: 60, enabled: false },
    outagePostmortems: { enabled: false },
    marquee: { timeoutMs: 5000 },
    apns: { environment: "development", criticalAlerts: false, alertTtlSeconds: 3600 },
  } as unknown as AppConfig;
}

// A credential whose token is a fixed fake — no DefaultAzureCredential, no live
// AAD round trip. getToken is non-async on purpose (nothing to await).
function makeCredential(): TokenCredential {
  return {
    getToken: () => Promise.resolve({ token: "fake-mgmt-token", expiresOnTimestamp: Date.now() + 3_600_000 }),
  };
}

// The log routes never touch the ARM SDK clients, so a bare cast is sufficient.
const dummyClients = {} as unknown as AzureArmClients;

// ── Fake upstream (routes by URL; throws on anything unexpected) ──────────────

interface UpstreamOptions {
  /** logLink returned by listLogSasUrl; `null` => `{}` (no SAS available). */
  readonly sasUrl?: string | null;
  /** Run-detail JSON returned by the ARM run GET. */
  readonly run?: { name?: string; properties?: Record<string, unknown> };
  /** Blob GET behaviour. Receives the request init so it can observe the abort signal. */
  readonly blob?: (init?: RequestInit) => Promise<Response>;
}

function makeUpstream(opts: UpstreamOptions): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const sas = opts.sasUrl === undefined ? SAS_URL : opts.sasUrl;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);

    if (url.includes("/listLogSasUrl")) {
      const payload = sas ? { logLink: sas } : {};
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("blob.core.windows.net")) {
      if (!opts.blob) throw new Error("blob fetch not configured for this test");
      return await opts.blob(init);
    }
    if (url.includes("/runs/")) {
      const body = opts.run ?? { name: "ca123", properties: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Any other URL means the code tried to make a live call — fail loudly.
    throw new Error(`unexpected upstream fetch: ${method} ${url}`);
  };

  return { fetchImpl, calls };
}

function textBlob(body: string, contentType = "text/plain"): (init?: RequestInit) => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": contentType } }));
}

// ── App builder ──────────────────────────────────────────────────────────────

function makeApp(opts: {
  role?: AppRole | null;
  enabled?: boolean;
  requestTimeoutMs?: number;
  fetchImpl: typeof fetch;
  credential?: TokenCredential;
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (opts.role != null) {
      res.locals.identity = {
        tenantId: "t", oid: "o", email: "x@x", displayName: "X",
        roles: [opts.role] as AppRole[],
        featurePermissions: {}, firstSeenAt: 0, lastSeenAt: 0,
      };
    }
    next();
  });
  app.use(createAzureRouter({
    config: makeConfig({ enabled: opts.enabled, requestTimeoutMs: opts.requestTimeoutMs }),
    clients: dummyClients,
    cache: createAzureCache(),
    fetch: opts.fetchImpl,
    credential: opts.credential ?? makeCredential(),
  }));
  app.use(errorHandler);
  return app;
}

// ── 1. Run-detail JSON contains no SAS material ──────────────────────────────

test("run-detail JSON contains no SAS/signature/upstream URL", async () => {
  const { fetchImpl } = makeUpstream({
    run: { name: "ca123", properties: { status: "Succeeded", runType: "QuickBuild" } },
    blob: textBlob(RUN_LOG),
  });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(DETAIL_PATH, base));
    assert.equal(res.status, 200);
    const raw = await res.text();

    // Scan the whole serialized body, not just individual fields.
    for (const needle of ["sig=", "se=", "sp=", "sv=", "st=", "skoid=", "sktid=", "logSasUrl", "logLink", "blob.core.windows.net"]) {
      assert.ok(!raw.includes(needle), `run-detail body must not contain "${needle}"`);
    }
    assert.ok(!raw.includes("UNIQUESIGVALUE1234567890"), "must not leak the SAS signature");
    assert.ok(!raw.includes("LAYERSIGSECRET"), "must not leak a secret embedded in the log tail");

    const body = JSON.parse(raw) as { logAvailable?: boolean; logTail?: string | null };
    assert.equal(body.logAvailable, true);
    assert.ok(typeof body.logTail === "string" && body.logTail.includes("[redacted-url]"));
  });
});

// ── 2. Proxy happy path ──────────────────────────────────────────────────────

test("proxy returns sanitized log text and never fetches run detail", async () => {
  const { fetchImpl, calls } = makeUpstream({ blob: textBlob("Hello build log\nDone") });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 200);
    const body = await res.json() as { runId: string; log: string; bytes: number; truncated: boolean };
    assert.equal(body.runId, "ca123");
    assert.equal(body.log, "Hello build log\nDone");
    assert.equal(body.bytes, 20);
    assert.equal(body.truncated, false);

    assert.ok(calls.some((c) => c.includes("/listLogSasUrl")), "resolves the SAS server-side");
    assert.ok(calls.some((c) => c.includes("blob.core.windows.net")), "reads the blob server-side");
    assert.ok(!calls.some((c) => /GET .*\/runs\/[^/]+\?api-version/.test(c)), "proxy must not fetch run detail");
  });
});

// ── 3. Byte-cap enforcement (bounded, signalled) ─────────────────────────────

test("fetchAcrRunLog stops at maxBytes and signals truncation", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response("A".repeat(50), { status: 200, headers: { "content-type": "text/plain" } }));
  const result = await fetchAcrRunLog(SAS_URL, fetchImpl, { maxBytes: 10, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, 10);
    assert.ok(result.text.length <= 10, "text is bounded by the byte cap");
  }
});

test("ACR_LOG_MAX_BYTES is a 2 MiB budget", () => {
  assert.equal(ACR_LOG_MAX_BYTES, 2 * 1024 * 1024);
});

// ── 4. Timeout (direct + through the route) ──────────────────────────────────

function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      // Surface the abort as a TimeoutError so the proxy classifies it as a
      // bounded timeout rather than a transport error.
      const error = new Error("upstream aborted");
      error.name = "TimeoutError";
      reject(error);
    });
  });
}

test("fetchAcrRunLog reports a timeout when the upstream hangs", async () => {
  const hanging: typeof fetch = (_input, init) => hangUntilAbort(init);
  const result = await fetchAcrRunLog(SAS_URL, hanging, { maxBytes: ACR_LOG_MAX_BYTES, timeoutMs: 20 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
});

test("proxy returns a bounded typed 504 when the upstream hangs", async () => {
  const { fetchImpl } = makeUpstream({ blob: (init) => hangUntilAbort(init) });
  await withAppServer(makeApp({ role: "viewer", requestTimeoutMs: 50, fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 504);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "log_timeout");
    assert.ok(!raw.includes("blob.core.windows.net"), "timeout error must not leak the upstream URL");
    assert.ok(!raw.includes("UNIQUESIGVALUE1234567890"), "timeout error must not leak the SAS");
  });
});

// ── 5. Unexpected content type ───────────────────────────────────────────────

test("proxy rejects an unexpected content type", async () => {
  const { fetchImpl } = makeUpstream({ blob: textBlob('{"error":"nope"}', "application/json") });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 502);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error: { code: string } };
    assert.equal(body.error.code, "log_unsupported_content_type");
    assert.ok(!raw.includes("nope"), "must not echo the upstream body");
    assert.ok(!raw.includes("blob.core.windows.net"));
  });
});

// ── 6. Sanitization rules ────────────────────────────────────────────────────

test("sanitizeAcrLogText strips ANSI/control chars and redacts secrets", () => {
  const esc = "\u001b";
  const ansi = `${esc}[31mERRORTEXT${esc}[0m`;
  const controls = "a\u0000b\u0007c\bd";
  const keep = "line1\tcol\nline2";
  const sasInUrl =
    "see https://myacct.blob.core.windows.net/logs/x.txt?sv=2021-08-06&se=2026-01-02&sp=r&sig=SUPERSECRETSIG123==";
  const scheme = "Bearer";
  const tok = "aGVsbG8td29ybGQtdG9rZW4xMjM0";
  const bearerLine = `authorization: ${scheme} ${tok}`;
  const jwt = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const conn = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcd1234SECRETKEY==;EndpointSuffix=core.windows.net";

  const out = sanitizeAcrLogText([ansi, controls, keep, sasInUrl, bearerLine, jwt, conn].join("\n"));

  // ANSI removed, but the wrapped content is preserved.
  assert.ok(!out.includes(esc), "ANSI escape introducer removed");
  assert.ok(out.includes("ERRORTEXT"), "text inside ANSI wrapper is preserved");
  // Control chars removed; tab and newline preserved.
  assert.ok(!out.includes("\u0000") && !out.includes("\u0007") && !out.includes("\b"), "control chars stripped");
  assert.ok(out.includes("\t") && out.includes("\n"), "tab and newline preserved");
  // Blob URL (host + SAS) redacted whole.
  assert.ok(!out.includes("blob.core.windows.net"), "blob host redacted");
  assert.ok(!out.includes("SUPERSECRETSIG123"), "SAS signature value redacted");
  assert.ok(out.includes("[redacted-url]"), "blob URL replaced with placeholder");
  // Bearer token redacted.
  assert.ok(!out.includes(tok), "bearer token value redacted");
  assert.ok(out.includes(`${scheme} [redacted]`), "bearer token replaced with scheme + placeholder");
  // JWT redacted.
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT redacted");
  assert.ok(out.includes("[redacted-token]"), "JWT replaced with placeholder");
  // Connection-string secret redacted (value gone, key kept).
  assert.ok(!out.includes("abcd1234SECRETKEY"), "account key value redacted");
  assert.ok(out.includes("AccountKey=[redacted]"), "account key replaced with placeholder");
});

// ── 7. Upstream failures fail safely ─────────────────────────────────────────

test("proxy maps an upstream 5xx to a safe typed error", async () => {
  const { fetchImpl } = makeUpstream({
    blob: () => Promise.resolve(new Response("Internal Server Error at myacct.blob.core.windows.net", { status: 500 })),
  });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 502);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "log_upstream_error");
    assert.ok(!raw.includes("blob.core.windows.net"), "must not leak the upstream URL");
    assert.ok(!raw.includes("Internal Server Error"), "must not leak the provider error string");
  });
});

test("proxy maps a network throw to a safe typed error", async () => {
  const { fetchImpl } = makeUpstream({
    blob: () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED myacct.blob.core.windows.net")),
  });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 502);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error: { code: string } };
    assert.equal(body.error.code, "log_fetch_failed");
    assert.ok(!raw.includes("blob.core.windows.net"), "must not leak the upstream URL");
    assert.ok(!raw.includes("ECONNREFUSED"), "must not leak transport internals");
  });
});

test("proxy returns 404 when no build log is available", async () => {
  const { fetchImpl, calls } = makeUpstream({ sasUrl: null });
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 404);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "log_unavailable");
    assert.ok(!calls.some((c) => c.includes("blob.core.windows.net")), "no blob read when there is no SAS");
  });
});

// ── 8. Authorization / enablement ────────────────────────────────────────────

test("proxy rejects an unauthenticated request and makes no upstream call", async () => {
  const { fetchImpl, calls } = makeUpstream({ blob: textBlob("secret log") });
  await withAppServer(makeApp({ role: null, fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, "no token or upstream fetch for an unauthorized caller");
  });
});

test("run-detail rejects an unauthenticated request", async () => {
  const { fetchImpl, calls } = makeUpstream({ blob: textBlob(RUN_LOG) });
  await withAppServer(makeApp({ role: null, fetchImpl }), async (base) => {
    const res = await fetch(new URL(DETAIL_PATH, base));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });
});

test("proxy returns 503 when the azure integration is disabled", async () => {
  const { fetchImpl, calls } = makeUpstream({ blob: textBlob("log") });
  await withAppServer(makeApp({ role: "viewer", enabled: false, fetchImpl }), async (base) => {
    const res = await fetch(new URL(LOG_PATH, base));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });
});

test("ACR route parameters cannot escape the pinned ARM resource path", async () => {
  const { fetchImpl, calls } = makeUpstream({ blob: textBlob("log") });
  const app = makeApp({ role: "viewer", fetchImpl });
  await withAppServer(app, async (base) => {
    const paths = [
      "/api/azure/acr/x%2Fproviders%2FMicrosoft.Web%2Fsites%2Fvictim%2Frestart%3Fapi-version%3D2022-03-01/myreg/runs/ca123/log",
      "/api/azure/acr/rg-test/myreg%2F..%2Fevil/runs/ca123",
      "/api/azure/acr/rg-test/myreg/runs/ca123%3Fapi-version%3D2022-03-01/log",
      "/api/azure/acr/..%2F..%2Fevil/myreg/runs",
      "/api/azure/acr/rg-test/myreg%2F..%2Fevil/repositories"
    ];
    for (const path of paths) {
      const response = await fetch(new URL(path, base));
      assert.equal(response.status, 400, `${path} was not rejected before ARM access`);
    }
  });
  assert.equal(calls.length, 0, "invalid route parameters must not acquire or send an ARM request");
});

test("an untrusted logLink host is never fetched", async () => {
  let blobFetches = 0;
  const malicious = "https://169.254.169.254/metadata/identity/oauth2/token";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/listLogSasUrl")) {
      return new Response(JSON.stringify({ logLink: malicious }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    blobFetches += 1;
    throw new Error(`unexpected fetch ${url}`);
  };
  await withAppServer(makeApp({ role: "viewer", fetchImpl }), async (base) => {
    const response = await fetch(new URL(LOG_PATH, base));
    assert.equal(response.status, 404);
  });
  assert.equal(blobFetches, 0);
  assert.equal(isTrustedAcrLogUrl(malicious), false);
});

test("the bounded log client rejects untrusted URLs before calling fetch", async () => {
  let called = false;
  const result = await fetchAcrRunLog(
    "https://example.invalid/log?sig=secret",
    async () => {
      called = true;
      return new Response("should not be read");
    },
    { maxBytes: 1024, timeoutMs: 1000 }
  );
  assert.deepEqual(result, { ok: false, reason: "untrusted_url" });
  assert.equal(called, false);
  assert.equal(
    isTrustedAcrLogUrl("https://acct.blob.core.windows.net:444/log?sig=secret"),
    false
  );
});
