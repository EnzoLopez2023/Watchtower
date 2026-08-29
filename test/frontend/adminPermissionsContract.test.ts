/**
 * Contract test for the app-local Admin permissions surface.
 *
 * The per-view permission feature keeps four independent copies of the same
 * eleven production view ids: the ownership manifest, the server's request
 * validator, the frontend view union, and the navigation table. When any two
 * drift the symptom is a silent `invalid_feature_permission` rejection, or a
 * view the Admin screen cannot label — neither of which any other test catches.
 *
 * Two deliberate design choices:
 *
 *   * The assertions read source rather than importing it, because `src/**` is
 *     compiled with bundler module resolution while this project is NodeNext.
 *     Parsing keeps the guard runnable without weakening either tsconfig.
 *   * Three of the four sources are owned by other work streams and may be
 *     mid-edit. A cross-boundary check therefore **skips** when its declaration
 *     cannot be located at all, and **fails** only when it parses and
 *     disagrees. A frontend file that will not parse is always a failure — that
 *     half is this scope's own.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath: string): string | null {
  try {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
  } catch {
    return null;
  }
}

/** Pull the string literals out of a named array/Set declaration. */
function stringList(source: string, declaration: RegExp): string[] | null {
  const block = declaration.exec(source);
  const body = block?.[1];
  if (!body) return null;
  return [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] as string);
}

function parse(relativePath: string, declaration: RegExp): string[] | null {
  const source = read(relativePath);
  return source ? stringList(source, declaration) : null;
}

/**
 * Frontend sources are this scope's own, so an unreadable one is a failure
 * rather than a reason to skip.
 */
function requireFrontend(relativePath: string): string {
  const source = read(relativePath);
  assert.ok(source, `frontend source is missing: ${relativePath}`);
  return source;
}

const frontendViewIds = (): string[] => {
  const ids = stringList(
    requireFrontend("src/types/AppView.ts"),
    /PRODUCTION_VIEWS[^=]*=\s*\[([\s\S]*?)\]\s*as const/
  );
  assert.ok(ids, "PRODUCTION_VIEWS could not be parsed from src/types/AppView.ts");
  return ids;
};

const manifestViewIds = (): string[] | null =>
  parse("lib/db/import/ownership.ts", /OWNED_VIEW_IDS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);

const serverFeatureIds = (): string[] | null =>
  parse("server/routes/core.ts", /WATCHTOWER_FEATURES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);

// ── Frontend-internal invariants (always enforced) ───────────────────────────

test("the frontend owns exactly eleven production view ids", () => {
  const frontend = frontendViewIds();
  assert.equal(frontend.length, 11);
  assert.equal(new Set(frontend).size, 11, "production view ids are unique");
  for (const view of frontend) {
    assert.match(view, /^[a-z][a-z0-9-]*$/, `unexpected view id shape: ${view}`);
  }
});

test("the client builds an encoded feature-permission path and sends both booleans", () => {
  const client = requireFrontend("src/services/admin.ts");

  // A tenant id or oid is opaque and must never be interpolated raw into a path.
  assert.match(
    client,
    /\/api\/admin\/users\/\$\{encodeURIComponent\(tenantId\)\}\/\$\{encodeURIComponent\(oid\)\}\/features\/\$\{encodeURIComponent\(feature\)\}/,
    "feature permission path encodes each segment"
  );
  assert.match(
    client,
    /\/api\/admin\/users\/\$\{encodeURIComponent\(tenantId\)\}\/\$\{encodeURIComponent\(oid\)\}\/roles/,
    "role path encodes each segment"
  );
  // The server requires both keys to be booleans, so the client must always
  // send the full pair rather than a partial patch.
  assert.match(
    client,
    /\{\s*canEdit:\s*permission\.canEdit,\s*isHidden:\s*permission\.isHidden\s*\}/,
    "feature permission body carries both booleans"
  );
});

test("Admin screen exposes both switches for every production view", () => {
  const admin = requireFrontend("src/Admin.tsx");

  assert.ok(
    admin.includes("PRODUCTION_VIEWS.map("),
    "the permission editor iterates the full production view list"
  );
  assert.ok(
    admin.includes("updateUserFeaturePermission"),
    "the editor writes through the feature permission endpoint"
  );

  // canEdit and isHidden are separate controls; collapsing them would make an
  // imported read-only rule indistinguishable from a hidden view.
  assert.equal(
    (admin.match(/canEdit:\s*event\.target\.checked/g) ?? []).length,
    1,
    "exactly one control writes canEdit"
  );
  assert.equal(
    (admin.match(/isHidden:\s*event\.target\.checked/g) ?? []).length,
    1,
    "exactly one control writes isHidden"
  );
});

test("the listed identity is the source of the permission map the editor renders", () => {
  const admin = requireFrontend("src/Admin.tsx");
  const identity = requireFrontend("src/services/identity.ts");

  assert.match(
    identity,
    /featurePermissions:\s*FeaturePermissionMap/,
    "AppIdentity carries the permission map returned by GET /api/admin/users"
  );
  assert.ok(
    admin.includes("user.featurePermissions[view]"),
    "the editor reads each row from the listed identity, not from /api/me"
  );
});

test("each writable page fences its own edits through the shared rule set", () => {
  // Acceptance finding 1: a global operator must not be offered writes. The
  // pages get that for free only if they actually consult useReadOnly, so the
  // three with write endpoints are checked by name.
  const pages: readonly [string, string][] = [
    ["src/PowerTopology/index.tsx", "power-topology"],
    ["src/IpMigration.tsx", "ip-migration"],
    ["src/Synology.tsx", "synology"]
  ];

  for (const [file, view] of pages) {
    const source = requireFrontend(file);
    assert.ok(
      source.includes(`useReadOnly('${view}')`),
      `${file} must fence on useReadOnly('${view}')`
    );
    assert.ok(source.includes("readOnly"), `${file} must apply the fence to its affordances`);
  }
});

test("the edit rule never grants from the operator role alone", () => {
  const rules = requireFrontend("src/services/permissions.ts");

  // The final decision must be an explicit-grant check. A fallback such as
  // `return WRITABLE.has(view)` would reintroduce the global-operator grant
  // that acceptance finding 1 rejected.
  assert.match(
    rules,
    /return storedPermission\(subject, view\)\?\.canEdit === true;/,
    "canEditView must end in an explicit canEdit:true check"
  );
  assert.doesNotMatch(
    rules,
    /return\s+WRITABLE\.has\(view\)/,
    "the writable-view set must not be used as a grant"
  );
  assert.doesNotMatch(
    rules,
    /return\s+isManagedFeature\(view\)/,
    "the managed-feature helper must not be used as a grant"
  );
});

test("every production view has a navigation route with a distinct standalone URL", () => {
  const navigation = requireFrontend("src/app/navigation.ts");

  const paths = frontendViewIds().map((view) => {
    const entry = new RegExp(`view: '${view}',\\s*\\n\\s*path: '([^']+)'`).exec(navigation);
    assert.ok(entry, `no navigation route for ${view}`);
    return entry[1] as string;
  });

  assert.equal(new Set(paths).size, paths.length, "standalone URLs are unique");
  for (const routePath of paths) {
    assert.match(routePath, /^\/[a-z0-9/-]*$/, `unexpected URL shape: ${routePath}`);
  }
});

// ── Cross-boundary drift guards (skipped while a source is mid-edit) ─────────

test("frontend production view ids match the ownership manifest exactly", (t: TestContext) => {
  const manifest = manifestViewIds();
  if (!manifest?.length) {
    t.skip("OWNED_VIEW_IDS not parseable yet — manifest is owned by another work stream");
    return;
  }
  // Order matters as well as membership: the Admin screen lists views in this
  // order, and matching the manifest keeps the two reviewable side by side.
  assert.deepEqual(frontendViewIds(), manifest);
});

test("every id the Admin screen can send is accepted by the server validator", (t: TestContext) => {
  const ids = serverFeatureIds();
  if (!ids?.length) {
    t.skip("WATCHTOWER_FEATURES not parseable yet — the route module is owned by another work stream");
    return;
  }
  const server = new Set(ids);
  const frontend = frontendViewIds();

  assert.deepEqual(
    frontend.filter((view) => !server.has(view)),
    [],
    "frontend ids the server would reject with invalid_feature_permission"
  );
  assert.deepEqual(
    [...server].filter((view) => !frontend.includes(view)),
    [],
    "server features the Admin screen cannot reach"
  );
});

test("the client builds the route the server actually registers", (t: TestContext) => {
  const server = read("server/routes/core.ts");
  if (!server?.includes("/api/admin/users/")) {
    t.skip("admin routes not registered yet — the route module is owned by another work stream");
    return;
  }
  assert.ok(
    server.includes('"/api/admin/users/:tenantId/:oid/features/:feature"'),
    "server registers the feature permission route the client calls"
  );
  assert.ok(
    server.includes('"/api/admin/users/:tenantId/:oid/roles"'),
    "server registers the role route the client calls"
  );
});

test("standalone URLs match the ownership documentation", (t: TestContext) => {
  const doc = read("docs/OWNERSHIP.md");
  const rows = doc
    ? [...doc.matchAll(/^\|\s`([a-z-]+)`\s\|\s`([^`]+)`\s\|$/gm)].map(
        (match) => [match[1] as string, match[2] as string] as const
      )
    : [];
  if (rows.length !== 11) {
    t.skip("ownership table not in its final shape yet — docs are owned by another work stream");
    return;
  }

  const navigation = requireFrontend("src/app/navigation.ts");
  for (const [view, url] of rows) {
    const pattern = new RegExp(`view: '${view}',\\s*\\n\\s*path: '${url.replace(/\//g, "\\/")}'`);
    assert.match(navigation, pattern, `${view} must be served at ${url}`);
  }
});
