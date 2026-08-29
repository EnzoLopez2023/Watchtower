import assert from "node:assert/strict";
import test from "node:test";
import { Router, type RequestHandler } from "express";
import { SqliteAuditRepository } from "../../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import { SqliteReadinessRepository } from "../../lib/db/repositories/readinessRepository.js";
import { SqliteSettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { withAppServer } from "../helpers/appTestServer.js";
import { withTestDatabase } from "../helpers/database.js";

test("default readiness fails closed until all 54 owned tables exist", async () => {
  await withTestDatabase(async (database) => {
    const readiness = await new SqliteReadinessRepository(database).check();
    assert.equal(readiness.ok, false);
    assert.equal(readiness.ownedTableCount, 0);
    assert.equal(readiness.requiredOwnedTableCount, 54);
  });
});

test("readiness fails closed when the owned schema digest drifts", async () => {
  await withTestDatabase(async (database) => {
    const readiness = await new SqliteReadinessRepository(
      database,
      [],
      "0".repeat(64)
    ).check();
    assert.equal(readiness.ok, false);
    assert.equal(readiness.expectedOwnedSchemaDigest, "0".repeat(64));
    assert.notEqual(readiness.ownedSchemaDigest, readiness.expectedOwnedSchemaDigest);
  });
});

test("/api/live is process-only and /api/ready performs the bounded DB check", async () => {
  await withTestDatabase(async (database, directory) => {
    let authCalls = 0;
    let readinessCalls = 0;
    const readiness = new SqliteReadinessRepository(database, []);
    const app = createApp({
      config: loadConfig({ NODE_ENV: "test", DB_PATH: `${directory}/watchtower.db` }),
      core: {
        startedAt: Date.now() - 2000,
        databasePath: `${directory}/watchtower.db`,
        lifecycle: () => ({ state: "ready" }),
        readiness: {
          async check() {
            readinessCalls += 1;
            return readiness.check();
          }
        },
        workers: { status: () => ({ alertEngine: { state: "healthy", updatedAt: Date.now() } }) },
        identities: new SqliteIdentityRepository(database),
        audit: new SqliteAuditRepository(database),
        settings: new SqliteSettingsRepository(database)
      },
      authenticate: ((_request, _response, next) => {
        authCalls += 1;
        next();
      }) satisfies RequestHandler,
      features: Router()
    });

    await withAppServer(app, async (baseUrl) => {
      const live = await fetch(new URL("/api/live", baseUrl));
      assert.equal(live.status, 200);
      assert.equal(readinessCalls, 0);
      assert.equal(authCalls, 0);

      const ready = await fetch(new URL("/api/ready", baseUrl));
      assert.equal(ready.status, 200);
      const body = (await ready.json()) as {
        ok: boolean;
        authority: {
          journalMode: string;
          schemaVersion: number;
          ownedTableCount: number;
          requiredOwnedTableCount: number;
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.authority.journalMode, "delete");
      assert.equal(body.authority.schemaVersion, 2);
      assert.equal(body.authority.ownedTableCount, 0);
      assert.equal(body.authority.requiredOwnedTableCount, 0);
      assert.equal(readinessCalls, 1);
      assert.equal(authCalls, 0);
    });
  });
});

test("/api/ready returns a secret-safe 503 when its cheap check fails", async () => {
  await withTestDatabase(async (database, directory) => {
    const app = createApp({
      config: loadConfig({ NODE_ENV: "test", DB_PATH: `${directory}/watchtower.db` }),
      core: {
        startedAt: Date.now(),
        databasePath: `${directory}/watchtower.db`,
        lifecycle: () => ({ state: "ready" }),
        readiness: { async check() { throw new Error("sensitive database detail"); } },
        workers: { status: () => ({}) },
        identities: new SqliteIdentityRepository(database),
        audit: new SqliteAuditRepository(database),
        settings: new SqliteSettingsRepository(database)
      },
      authenticate: ((_request, _response, next) => next()) satisfies RequestHandler,
      features: Router()
    });
    await withAppServer(app, async (baseUrl) => {
      const response = await fetch(new URL("/api/ready", baseUrl));
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.doesNotMatch(text, /sensitive database detail/);
      assert.match(text, /readiness_failed/);
    });
  });
});
