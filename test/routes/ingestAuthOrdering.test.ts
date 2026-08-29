import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { createTestHarness, testConfig, type TestHarness } from "../fixtures/monitoring/harness.js";

/**
 * Every ingest route declares `express.json({ limit: "50mb" })`. If the parser
 * were reachable before authentication, an anonymous caller could make this
 * process read and buffer 50 MB per connection. These tests assert the opposite
 * ordering both structurally and by execution.
 */

const INGEST_ROUTES = [
  "/api/unifi/ingest",
  "/api/unifi/logs/ingest",
  "/api/ups/ingest",
  "/api/protect/ingest",
  "/api/synology/ingest",
  "/api/network-observer/ingest",
  "/api/agent-logs/ingest",
  "/api/mobile/register-device",
] as const;

const ROUTE_SOURCES = [
  "server/routes/features/unifi.ts",
  "server/routes/features/unifiLogs.ts",
  "server/routes/features/ups.ts",
  "server/routes/features/protect.ts",
  "server/routes/features/synology.ts",
  "server/routes/features/networkObserver.ts",
  "server/routes/features/agentLogs.ts",
  "server/routes/features/mobile.ts",
] as const;

const STATIC_ORDER = [
  { file: ROUTE_SOURCES[0], path: INGEST_ROUTES[0], auth: "requireServiceToken", parser: "express.json" },
  { file: ROUTE_SOURCES[1], path: INGEST_ROUTES[1], auth: "requireServiceToken", parser: "express.json" },
  { file: ROUTE_SOURCES[2], path: INGEST_ROUTES[2], auth: "requireServiceToken", parser: "express.json" },
  { file: ROUTE_SOURCES[3], path: INGEST_ROUTES[3], auth: "requireServiceToken", parser: "express.json" },
  { file: ROUTE_SOURCES[4], path: INGEST_ROUTES[4], auth: "requireServiceToken", parser: "express.json" },
  { file: ROUTE_SOURCES[5], path: INGEST_ROUTES[5], auth: "authenticate", parser: "express.json" },
  { file: ROUTE_SOURCES[6], path: INGEST_ROUTES[6], auth: "preAuthenticate", parser: "parseBody" },
  { file: ROUTE_SOURCES[7], path: INGEST_ROUTES[7], auth: "authenticate", parser: "json" },
] as const;

let server: Server;
let port = 0;
let harness: TestHarness;

before(() => {
  harness = createTestHarness({
    prefix: "ingest-auth",
    config: testConfig({
      serviceTokens: {
        unifi: "unifi-secret",
        ups: "ups-secret",
        protect: "protect-secret",
        synology: "synology-secret",
        sonarr: "sonarr-secret",
        networkObserver: "observer-secret",
        agentLog: "agent-secret",
        mobile: "mobile-secret"
      }
    })
  });
  server = harness.app.listen(0);
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

after(() => {
  server.close();
  harness.close();
});

/**
 * Opens a chunked POST with a bad token, writes one small chunk and never ends
 * the body. `express.json` only resolves once the request stream completes, so
 * a status line can arrive only if authentication rejected the request without
 * waiting for the body.
 */
function rejectBeforeBodyEnds(
  path: string
): Promise<{ status: number; bytesSent: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer definitely-not-the-secret",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, bytesSent: req.socket?.bytesWritten ?? 0 });
        req.destroy();
      }
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      // The client tears the socket down after the response; ignore that.
      if (error.code === "ECONNRESET") return;
      reject(error);
    });
    // A deliberately incomplete body: opened, never finished.
    req.write('{"partial":true');
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`${path} did not answer while the body was still open — the parser ran before auth`));
    }, 4_000);
    timer.unref();
  });
}

for (const path of INGEST_ROUTES) {
  test(`${path} rejects an unauthenticated caller before parsing the body`, async () => {
    const { status } = await rejectBeforeBodyEnds(path);
    assert.ok(
      status === 401 || status === 503,
      `expected an auth rejection with the body still open, got ${status}`
    );
  });
}

test("no ingest route mounts a body parser ahead of its authentication", () => {
  const offenders: string[] = [];
  for (const contract of STATIC_ORDER) {
    const source = readFileSync(contract.file, "utf8");
    const routeAt = source.indexOf(`"${contract.path}"`);
    if (routeAt < 0) {
      offenders.push(`${contract.file}: route ${contract.path} not found`);
      continue;
    }
    const nextRouteAt = source.indexOf("router.", routeAt + contract.path.length);
    const registration = source.slice(
      routeAt,
      nextRouteAt < 0 ? source.length : nextRouteAt
    );
    const authAt = registration.indexOf(contract.auth);
    const parserAt = registration.indexOf(contract.parser);
    if (authAt < 0) offenders.push(`${contract.file}: ${contract.auth} not found`);
    if (parserAt < 0) offenders.push(`${contract.file}: ${contract.parser} not found`);
    if (authAt >= 0 && parserAt >= 0 && authAt > parserAt) {
      offenders.push(`${contract.file}: ${contract.parser} precedes ${contract.auth}`);
    }
  }
  assert.equal(STATIC_ORDER.length, INGEST_ROUTES.length);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the audited inventory covers every mounted ingest route", () => {
  const mounted = new Set<string>();
  for (const file of ROUTE_SOURCES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/router\.post\(\s*\n?\s*"(\/api\/[^"]+)"/g)) {
      const path = match[1];
      if (path && source.includes("express.json")) mounted.add(path);
    }
  }
  for (const path of mounted) {
    if (path.startsWith("/api/mobile/") && !INGEST_ROUTES.includes(path as never)) {
      // register/unregister/test-push all share one middleware chain; one is
      // executed above and the ordering rule is asserted for all of them.
      continue;
    }
    assert.ok(
      INGEST_ROUTES.includes(path as never),
      `${path} accepts a body but is not covered by the auth-ordering inventory`
    );
  }
});
