import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import {
  FEATURE_ROUTE_RULES,
  findFeatureRule,
  mountedRoutes,
  type FeatureRouteRule
} from "../../server/auth/featureRoutes.js";
import { canEditView, isViewVisible } from "../../server/auth/featureAccess.js";
import { OWNED_VIEW_IDS } from "../../lib/db/import/ownership.js";
import { createWatchtowerContainer } from "../../server/domain/container.js";
import { createFeatureRouters } from "../../server/routes/index.js";
import { errorHandler, notFoundHandler } from "../../server/http/errors.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";
import {
  identityWithFeatures,
  openTestDatabase,
  removeDatabase,
  stubApns,
  stubMediaHealth,
  testConfig
} from "../fixtures/monitoring/harness.js";
import type { SqliteDatabase } from "../../lib/db/connection.js";

/**
 * The route inventory is the whole point of the central rule table: if an
 * interactive endpoint can exist without a declared rule, the guard is
 * decorative. These tests walk the real Express stack rather than a hand-kept
 * list, so adding a route without a rule fails here.
 */

function buildRouters(prefix: string): {
  interactive: ReturnType<typeof createFeatureRouters>["interactive"];
  database: SqliteDatabase;
  path: string;
} {
  const { database, path } = openTestDatabase(prefix);
  const container = createWatchtowerContainer(database, testConfig(), {
    mediaHealth: stubMediaHealth(),
    apns: stubApns()
  });
  return { interactive: createFeatureRouters(container).interactive, database, path };
}

/** A concrete request path for a pattern, so the matcher can be exercised. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "sample");
}

test("every mounted interactive endpoint has a declared feature rule", () => {
  const built = buildRouters("inventory-rules");
  try {
    const mounted = mountedRoutes(built.interactive);
    assert.equal(mounted.length, 73, `the interactive surface changed, saw ${mounted.length}`);

    const missing = mounted.filter((route) => !findFeatureRule(route.method, concrete(route.path)));
    assert.deepEqual(
      missing.map((route) => `${route.method} ${route.path}`),
      [],
      "these endpoints would be reachable without a declared access rule"
    );
  } finally {
    built.database.close();
    removeDatabase(built.path);
  }
});

test("every declared rule corresponds to a real mounted endpoint", () => {
  const built = buildRouters("inventory-orphans");
  try {
    const mounted = new Set(
      mountedRoutes(built.interactive).map((route) => `${route.method} ${route.path}`)
    );
    const orphans = FEATURE_ROUTE_RULES.filter(
      (rule) => !mounted.has(`${rule.method} ${rule.path}`)
    );
    assert.deepEqual(
      orphans.map((rule) => `${rule.method} ${rule.path}`),
      [],
      "a rule for a route that does not exist hides drift"
    );
  } finally {
    built.database.close();
    removeDatabase(built.path);
  }
});

test("every rule names only manifest view ids, and all eleven views are covered", () => {
  const known = new Set<string>(OWNED_VIEW_IDS);
  const used = new Set<string>();
  for (const rule of FEATURE_ROUTE_RULES) {
    assert.ok(rule.views.length > 0, `${rule.method} ${rule.path} names no view`);
    for (const view of rule.views) {
      assert.ok(known.has(view), `${rule.method} ${rule.path} names unknown view ${view}`);
      used.add(view);
    }
  }
  const uncovered = OWNED_VIEW_IDS.filter((view) => !used.has(view));
  assert.deepEqual(uncovered, [], "these manifest views govern no endpoint");
});

test("writes are declared only where the route actually mutates", () => {
  const readMethods = new Set(["GET", "HEAD"]);
  for (const rule of FEATURE_ROUTE_RULES) {
    if (readMethods.has(rule.method)) {
      assert.equal(rule.kind, "read", `${rule.method} ${rule.path} should be a read`);
    } else {
      assert.equal(
        rule.kind,
        "write",
        `${rule.method} ${rule.path} mutates and must be guarded as a write`
      );
    }
  }
});

// ── Decision-level rules ─────────────────────────────────────────────────────

const VIEWER: readonly AppIdentity["roles"][number][] = ["viewer"];
const OPERATOR: readonly AppIdentity["roles"][number][] = ["viewer", "operator"];

function subject(
  roles: readonly AppIdentity["roles"][number][],
  featurePermissions: AppIdentity["featurePermissions"] = {}
): AppIdentity {
  return identityWithFeatures({ roles, featurePermissions });
}

test("a missing row keeps Hearth's defaults: visible, and read-only", () => {
  const operator = subject(OPERATOR);
  assert.equal(isViewVisible(operator, "power-topology"), true, "absent row stays visible");
  assert.equal(
    canEditView(operator, "power-topology"),
    false,
    "a global operator role must never become a write grant on its own"
  );
});

test("an explicit canEdit row grants the write, and only for that view", () => {
  const operator = subject(OPERATOR, {
    "power-topology": { canEdit: true, isHidden: false }
  });
  assert.equal(canEditView(operator, "power-topology"), true);
  assert.equal(
    canEditView(operator, "ip-migration"),
    false,
    "an edit right on one view must not leak into another"
  );
  assert.equal(canEditView(operator, "synology"), false);
});

test("a hidden view denies both reads and writes even with canEdit set", () => {
  const operator = subject(OPERATOR, {
    synology: { canEdit: true, isHidden: true }
  });
  assert.equal(isViewVisible(operator, "synology"), false);
  assert.equal(
    canEditView(operator, "synology"),
    false,
    "hidden must win over a stale canEdit row"
  );
});

test("a viewer with canEdit is still not a writer", () => {
  const viewer = subject(VIEWER, {
    "power-topology": { canEdit: true, isHidden: false }
  });
  assert.equal(
    canEditView(viewer, "power-topology"),
    false,
    "canEdit is a grant within the operator ceiling, never a promotion"
  );
});

test("admin bypasses hidden and read-only rows on every view", () => {
  const admin = subject(["viewer", "operator", "admin"], {
    synology: { canEdit: false, isHidden: true },
    "power-topology": { canEdit: false, isHidden: true }
  });
  for (const view of OWNED_VIEW_IDS) {
    assert.equal(isViewVisible(admin, view), true, `${view} must stay visible to an admin`);
    assert.equal(canEditView(admin, view), true, `${view} must stay editable by an admin`);
  }
});

// ── End-to-end enforcement over the real router stack ────────────────────────

interface Live {
  readonly base: string;
  close(): Promise<void>;
}

async function serve(
  prefix: string,
  identity: AppIdentity | null
): Promise<Live> {
  const { database, path } = openTestDatabase(prefix);
  const container = createWatchtowerContainer(database, testConfig(), {
    mediaHealth: stubMediaHealth(),
    apns: stubApns()
  });
  const routers = createFeatureRouters(container);
  const app = express();
  app.use(express.json());
  if (identity) {
    app.use((_request, response, next) => {
      response.locals.identity = identity;
      next();
    });
  }
  app.use(routers.interactive);
  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  const server: Server = await new Promise((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      removeDatabase(path);
    }
  };
}

test("a hidden feature answers 403 to a direct API call", async () => {
  const live = await serve(
    "hidden-direct",
    subject(OPERATOR, { synology: { canEdit: false, isHidden: true } })
  );
  try {
    for (const path of ["/api/synology", "/api/synology/history", "/api/synology/shares"]) {
      const response = await fetch(new URL(path, live.base));
      assert.equal(response.status, 403, `${path} leaked a hidden feature`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "feature_hidden");
    }
  } finally {
    await live.close();
  }
});

test("case-variant API paths cannot bypass feature visibility or edit rules", async () => {
  assert.equal(
    findFeatureRule("POST", "/API/Power/Diagrams")?.path,
    "/api/power/diagrams"
  );
  const live = await serve(
    "case-variant-guard",
    subject(OPERATOR, {
      "power-topology": { canEdit: false, isHidden: true }
    })
  );
  try {
    for (const [method, path] of [
      ["GET", "/API/Power/Diagrams"],
      ["POST", "/aPi/power/Diagrams"]
    ] as const) {
      const response = await fetch(new URL(path, live.base), {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "Must not be created" })
            }
          : {})
      });

      assert.equal(response.status, 403, `${method} ${path} bypassed the feature guard`);
    }
  } finally {
    await live.close();
  }
});

test("HEAD is governed by the same feature visibility rule as GET", async () => {
  assert.equal(
    findFeatureRule("HEAD", "/api/synology/shares")?.path,
    "/api/synology/shares"
  );
  const live = await serve(
    "head-guard",
    subject(OPERATOR, {
      synology: { canEdit: false, isHidden: true }
    })
  );
  try {
    for (const path of [
      "/api/synology",
      "/api/synology/shares",
      "/API/Synology/Disks"
    ]) {
      const response = await fetch(new URL(path, live.base), { method: "HEAD" });
      assert.equal(response.status, 403, `HEAD ${path} bypassed the hidden feature rule`);
    }
  } finally {
    await live.close();
  }
});

test("hiding one of two views that share data leaves the other readable", async () => {
  // UPS readings back both the Power Monitor page and the Power Topology
  // canvas, so hiding one must not blank out the other.
  const live = await serve(
    "shared-anyof",
    subject(OPERATOR, { "power-monitor": { canEdit: false, isHidden: true } })
  );
  try {
    const response = await fetch(new URL("/api/ups", live.base));
    assert.equal(response.status, 200, "power-topology still grants the UPS read");
  } finally {
    await live.close();
  }
});

test("hiding every view that shares data does deny the read", async () => {
  const live = await serve(
    "shared-anyof-denied",
    subject(OPERATOR, {
      "power-monitor": { canEdit: false, isHidden: true },
      "power-topology": { canEdit: false, isHidden: true }
    })
  );
  try {
    const response = await fetch(new URL("/api/ups", live.base));
    assert.equal(response.status, 403, "no visible view backs this data any more");
  } finally {
    await live.close();
  }
});

test("an operator without a canEdit row cannot write any managed feature", async () => {
  const live = await serve("write-denied", subject(OPERATOR));
  try {
    const attempts: ReadonlyArray<readonly [string, string, unknown]> = [
      ["POST", "/api/power/diagrams", { name: "Rack" }],
      ["PATCH", "/api/ip-plan/aa:bb:cc:dd:ee:ff", { planned_ip: "10.0.0.9" }],
      ["DELETE", "/api/synology/external/nas-1/dev-1", undefined],
      ["POST", "/api/azure/cache/bust", { prefix: "webapps" }]
    ];
    for (const [method, path, body] of attempts) {
      const response = await fetch(new URL(path, live.base), {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      assert.equal(response.status, 403, `${method} ${path} must be read-only by default`);
      const parsed = (await response.json()) as { error?: { code?: string } };
      assert.equal(parsed.error?.code, "feature_read_only");
    }
  } finally {
    await live.close();
  }
});

test("a grant on one feature does not authorise a write on another", async () => {
  const live = await serve(
    "cross-feature-escalation",
    subject(OPERATOR, { "power-topology": { canEdit: true, isHidden: false } })
  );
  try {
    const allowed = await fetch(new URL("/api/power/diagrams", live.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rack" })
    });
    assert.ok(
      allowed.status === 200 || allowed.status === 201,
      `the granted feature should write, saw ${allowed.status}`
    );

    // The same identity, a different feature: still read-only.
    for (const [method, path, body] of [
      ["PATCH", "/api/ip-plan/aa:bb:cc:dd:ee:ff", { planned_ip: "10.0.0.9" }],
      ["DELETE", "/api/synology/external/nas-1/dev-1", undefined]
    ] as ReadonlyArray<readonly [string, string, unknown]>) {
      const response = await fetch(new URL(path, live.base), {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      assert.equal(response.status, 403, `${method} ${path} escalated from another feature`);
    }
  } finally {
    await live.close();
  }
});

test("every write endpoint is refused for an operator holding no grants", async () => {
  const live = await serve("write-sweep", subject(OPERATOR));
  const writes = FEATURE_ROUTE_RULES.filter((rule) => rule.kind === "write");
  try {
    assert.equal(writes.length, 18, "the write surface changed — re-check the new rule");
    for (const rule of writes) {
      const response = await fetch(new URL(concrete(rule.path), live.base), {
        method: rule.method,
        headers: { "content-type": "application/json" },
        body: rule.method === "DELETE" ? undefined : JSON.stringify({})
      });
      assert.equal(
        response.status,
        403,
        `${rule.method} ${rule.path} was not refused without an explicit grant`
      );
    }
  } finally {
    await live.close();
  }
});

test("every read endpoint is refused when all of its views are hidden", async () => {
  const hideAll = Object.fromEntries(
    OWNED_VIEW_IDS.map((view) => [view, { canEdit: false, isHidden: true }])
  );
  const live = await serve("read-sweep", subject(OPERATOR, hideAll));
  const reads = FEATURE_ROUTE_RULES.filter((rule) => rule.kind === "read");
  try {
    assert.equal(reads.length, 55, "the read surface changed — re-check the new rule");
    for (const rule of reads) {
      const response = await fetch(new URL(concrete(rule.path), live.base), {
        method: rule.method
      });
      assert.equal(
        response.status,
        403,
        `${rule.method} ${rule.path} served data from a fully hidden feature`
      );
    }
  } finally {
    await live.close();
  }
});

test("an admin reaches every read endpoint despite every view being hidden", async () => {
  const hideAll = Object.fromEntries(
    OWNED_VIEW_IDS.map((view) => [view, { canEdit: false, isHidden: true }])
  );
  const live = await serve("admin-bypass", subject(["viewer", "operator", "admin"], hideAll));
  try {
    for (const rule of FEATURE_ROUTE_RULES.filter((entry) => entry.kind === "read")) {
      const response = await fetch(new URL(concrete(rule.path), live.base), {
        method: rule.method
      });
      assert.notEqual(
        response.status,
        403,
        `${rule.method} ${rule.path} refused an administrator`
      );
    }
  } finally {
    await live.close();
  }
});

test("an unknown /api path is still a typed 404, not a guard 403", async () => {
  const live = await serve("unknown-path", subject(OPERATOR));
  try {
    const response = await fetch(new URL("/api/does-not-exist", live.base));
    assert.equal(response.status, 404, "the guard must not mask unknown routes");
  } finally {
    await live.close();
  }
});

test("observability reads need admin and remain visibility-checked", async () => {
  const operator = await serve("observability-operator", subject(OPERATOR));
  try {
    const response = await fetch(new URL("/api/observability/logs", operator.base));
    assert.equal(response.status, 403, "observability is an admin surface");
  } finally {
    await operator.close();
  }
});

test("the rule table exposes a stable shape for every entry", () => {
  for (const rule of FEATURE_ROUTE_RULES satisfies readonly FeatureRouteRule[]) {
    assert.ok(rule.path.startsWith("/api/"), `${rule.path} is not an API path`);
    assert.match(rule.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
  }
});
