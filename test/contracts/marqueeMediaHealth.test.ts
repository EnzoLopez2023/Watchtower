import assert from "node:assert/strict";
import test from "node:test";
import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import {
  EntraMediaHealthClient,
  MediaHealthClientError,
  parseMediaHealthV1
} from "../../server/clients/marqueeMediaHealth.js";

const FROZEN_MEDIA_HEALTH = Object.freeze({
  schema: "marquee.media-health.v1",
  generatedAt: "2026-08-28T05:37:39.602Z",
  overall: "degraded",
  build: {
    app: "marquee",
    version: "1.0.0",
    sourceCommit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871"
  },
  sqlite: { ready: true, schemaVersion: 1 },
  providers: {
    plex: {
      configured: true,
      lastSuccessAt: "2026-08-28T05:37:30.000Z",
      lastFailureAt: null,
      latencyMs: 34
    },
    tautulli: {
      configured: true,
      lastSuccessAt: null,
      lastFailureAt: "2026-08-28T05:37:00.000Z",
      latencyMs: 2500
    }
  },
  sonarr: {
    present: true,
    freshness: "fresh",
    sampledAt: 1787895399602,
    receivedAt: 1787895399602,
    cadenceMs: 300000,
    series: 800,
    queue: 0,
    missing: 0,
    healthy: 800,
    pipeline: "healthy"
  },
  duplicates: {
    lastScanAt: null,
    successfulDeleteCount: 0,
    bytesSaved: 0,
    latestDeleteOutcomeAt: null
  }
});

class FakeCredential implements TokenCredential {
  public readonly scopes: string[] = [];

  public async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions
  ): Promise<AccessToken> {
    this.scopes.push(...(Array.isArray(scopes) ? scopes : [scopes]));
    return { token: "workload-access-token", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

test("media-health v1 parser freezes the Marquee contract shape", () => {
  assert.deepEqual(parseMediaHealthV1(FROZEN_MEDIA_HEALTH), FROZEN_MEDIA_HEALTH);
});

test("media client sends a Marquee-audienced bearer workload token", async () => {
  const credential = new FakeCredential();
  let requestUrl = "";
  let authorization = "";
  const client = new EntraMediaHealthClient({
    baseUrl: new URL("https://marquee.example/internal/"),
    scope: "api://marquee/.default",
    timeoutMs: 1000,
    credential,
    fetch: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(FROZEN_MEDIA_HEALTH), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await client.get();
  assert.equal(result.overall, "degraded");
  assert.equal(requestUrl, "https://marquee.example/api/contracts/v1/media-health");
  assert.equal(authorization, "Bearer workload-access-token");
  assert.deepEqual(credential.scopes, ["api://marquee/.default"]);
});

test("media client never turns an upstream failure into healthy data", async () => {
  const client = new EntraMediaHealthClient({
    baseUrl: new URL("https://marquee.example"),
    scope: "api://marquee/.default",
    timeoutMs: 1000,
    credential: new FakeCredential(),
    fetch: async () => new Response("unavailable", { status: 503 })
  });

  await assert.rejects(
    client.get(),
    (error: unknown) =>
      error instanceof MediaHealthClientError &&
      error.code === "upstream_error" &&
      error.status === 503
  );
});

test("media client rejects malformed contract data", async () => {
  const client = new EntraMediaHealthClient({
    baseUrl: new URL("https://marquee.example"),
    scope: "api://marquee/.default",
    timeoutMs: 1000,
    credential: new FakeCredential(),
    fetch: async () =>
      new Response(JSON.stringify({ ...FROZEN_MEDIA_HEALTH, overall: "excellent" }), {
        status: 200
      })
  });

  await assert.rejects(
    client.get(),
    (error: unknown) =>
      error instanceof MediaHealthClientError && error.code === "invalid_contract"
  );
});

test("media client bounds workload-token acquisition", async () => {
  const credential: TokenCredential = {
    async getToken(_scopes, options) {
      return new Promise<AccessToken>((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("token acquisition aborted")),
          { once: true }
        );
      });
    }
  };
  const client = new EntraMediaHealthClient({
    baseUrl: new URL("https://marquee.example"),
    scope: "api://marquee/.default",
    timeoutMs: 10,
    credential,
    fetch: async () => new Response(JSON.stringify(FROZEN_MEDIA_HEALTH))
  });
  await assert.rejects(
    client.get(),
    (error: unknown) =>
      error instanceof MediaHealthClientError && error.code === "timeout"
  );
});

test("media client bounds streamed responses without trusting content-length", async () => {
  const client = new EntraMediaHealthClient({
    baseUrl: new URL("https://marquee.example"),
    scope: "api://marquee/.default",
    timeoutMs: 1000,
    credential: new FakeCredential(),
    fetch: async () => new Response("x".repeat(256 * 1024 + 1))
  });
  await assert.rejects(
    client.get(),
    (error: unknown) =>
      error instanceof MediaHealthClientError && error.code === "invalid_contract"
  );
});
