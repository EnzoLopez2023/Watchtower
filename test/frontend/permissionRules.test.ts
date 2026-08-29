/**
 * The authorization decision matrix.
 *
 * Executes the real rules from `src/services/permissions.ts` rather than
 * asserting on source, because this is the fence the whole UI depends on and a
 * regression here silently hands out writes.
 *
 * The property under test, from acceptance finding 1: **an absent
 * `featurePermissions` row keeps Hearth's read-only default.** The `operator`
 * role is a ceiling — it can withhold a write but never grant one — so a global
 * operator with no row must not be offered edits on Power Topology, IP
 * Migration or Synology.
 *
 * The client modules live in the Vite project, which `tsconfig.node.json` does
 * not include. They are loaded through a computed specifier so they stay out of
 * this project's file graph — a static import would drag them in and fail the
 * whole-tree typecheck with TS6307 — while still executing the real shipped
 * implementation. The same pattern is used by the server-side parity test in
 * `test/routes/featureRuleParity.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

type Row = { readonly canEdit: boolean; readonly isHidden: boolean };

interface PermissionSubject {
  readonly roles: readonly string[];
  readonly featurePermissions: Readonly<Record<string, Row>>;
}

/**
 * Imported bindings are declared as readonly arrow-function properties rather
 * than methods so `@typescript-eslint/unbound-method` stays satisfied.
 */
interface ClientPermissions {
  readonly NO_ACCESS: PermissionSubject;
  readonly OPERATOR_FEATURES: readonly string[];
  readonly canEditView: (subject: PermissionSubject, view: string) => boolean;
  readonly canViewView: (subject: PermissionSubject, view: string) => boolean;
  readonly hasRole: (roles: readonly string[] | undefined, required: string) => boolean;
  readonly isViewHidden: (subject: PermissionSubject, view: string) => boolean;
  readonly readOnlyReason: (
    subject: PermissionSubject,
    view: string
  ) => "role" | "feature-rule" | null;
  readonly storedPermission: (subject: PermissionSubject, view: string) => Row | undefined;
}

interface ClientViews {
  readonly PRODUCTION_VIEWS: readonly string[];
}

const permissionsUrl = new URL("../../src/services/permissions.ts", import.meta.url).href;
const viewsUrl = new URL("../../src/types/AppView.ts", import.meta.url).href;

const rules = (await import(permissionsUrl)) as ClientPermissions;
const views = (await import(viewsUrl)) as ClientViews;

const canEditView = rules.canEditView;
const canViewView = rules.canViewView;
const isViewHidden = rules.isViewHidden;
const readOnlyReason = rules.readOnlyReason;
const storedPermission = rules.storedPermission;
const hasRole = rules.hasRole;
const NO_ACCESS = rules.NO_ACCESS;

const PRODUCTION_VIEWS = views.PRODUCTION_VIEWS;
/** The three views that actually have write endpoints. */
const WRITABLE = rules.OPERATOR_FEATURES;

function subject(
  roles: readonly string[],
  featurePermissions: Record<string, Row> = {}
): PermissionSubject {
  return { roles, featurePermissions };
}

const viewer = (rows?: Record<string, Row>) => subject(["viewer"], rows);
const operator = (rows?: Record<string, Row>) => subject(["viewer", "operator"], rows);
const admin = (rows?: Record<string, Row>) => subject(["viewer", "operator", "admin"], rows);

const GRANTED: Row = { canEdit: true, isHidden: false };
const DENIED: Row = { canEdit: false, isHidden: false };
const HIDDEN_BUT_EDITABLE: Row = { canEdit: true, isHidden: true };

// ── The modules actually loaded ──────────────────────────────────────────────

test("the real client rule module was loaded", () => {
  assert.equal(typeof canEditView, "function", "canEditView must be the shipped implementation");
  assert.equal(PRODUCTION_VIEWS.length, 11, "the eleven production views must be available");
  assert.deepEqual([...WRITABLE].sort(), ["ip-migration", "power-topology", "synology"]);
});

// ── Absent row: Hearth's read-only default ───────────────────────────────────

test("an absent row leaves every writable view read-only for a global operator", () => {
  const user = operator();
  for (const view of WRITABLE) {
    assert.equal(
      storedPermission(user, view),
      undefined,
      `${view} must genuinely have no stored row in this fixture`
    );
    assert.equal(
      canEditView(user, view),
      false,
      `${view} must stay read-only: the operator role is a ceiling, not a grant`
    );
  }
});

test("an absent row leaves every production view read-only for a global operator", () => {
  const user = operator();
  for (const view of PRODUCTION_VIEWS) {
    assert.equal(canEditView(user, view), false, `${view} must not be editable without a grant`);
  }
});

test("a partial grant does not leak to the other writable views", () => {
  const user = operator({ "power-topology": GRANTED });
  assert.equal(canEditView(user, "power-topology"), true);
  assert.equal(canEditView(user, "ip-migration"), false);
  assert.equal(canEditView(user, "synology"), false);
});

// ── Explicit rows ────────────────────────────────────────────────────────────

test("an explicit canEdit:false denies an operator", () => {
  for (const view of WRITABLE) {
    assert.equal(canEditView(operator({ [view]: DENIED }), view), false, view);
  }
});

test("an explicit canEdit:true permits an operator", () => {
  for (const view of WRITABLE) {
    assert.equal(canEditView(operator({ [view]: GRANTED }), view), true, view);
  }
});

// ── The operator ceiling ─────────────────────────────────────────────────────

test("a viewer is denied even by an explicit canEdit:true row", () => {
  for (const view of WRITABLE) {
    const user = viewer({ [view]: GRANTED });
    assert.equal(hasRole(user.roles, "operator"), false);
    assert.equal(
      canEditView(user, view),
      false,
      `${view}: a per-view grant must never promote a viewer past the ceiling`
    );
  }
});

test("an identity with no roles is denied everywhere, granted rows or not", () => {
  const user = subject([], { "power-topology": GRANTED, synology: GRANTED });
  for (const view of PRODUCTION_VIEWS) {
    assert.equal(canEditView(user, view), false, view);
    assert.equal(canViewView(user, view), false, view);
  }
});

test("the empty subject used while loading and after failure grants nothing", () => {
  for (const view of PRODUCTION_VIEWS) {
    assert.equal(canEditView(NO_ACCESS, view), false, view);
    assert.equal(canViewView(NO_ACCESS, view), false, view);
  }
  assert.equal(canEditView(NO_ACCESS, "admin"), false);
});

// ── Hidden ───────────────────────────────────────────────────────────────────

test("a hidden view denies edits even with canEdit:true and the operator role", () => {
  for (const view of WRITABLE) {
    const user = operator({ [view]: HIDDEN_BUT_EDITABLE });
    assert.equal(isViewHidden(user, view), true, `${view} must report as hidden`);
    assert.equal(canEditView(user, view), false, `${view}: hidden must deny the write`);
    assert.equal(canViewView(user, view), false, `${view}: hidden must deny opening it`);
  }
});

test("an absent row is visible, matching Hearth's default", () => {
  const user = operator();
  for (const view of PRODUCTION_VIEWS) {
    assert.equal(isViewHidden(user, view), false, view);
    assert.equal(canViewView(user, view), true, view);
  }
});

// ── Admin bypass ─────────────────────────────────────────────────────────────

test("an administrator bypasses absent rows, explicit denials and hidden flags", () => {
  const user = admin({
    "power-topology": DENIED,
    synology: { canEdit: false, isHidden: true }
  });

  for (const view of PRODUCTION_VIEWS) {
    assert.equal(canEditView(user, view), true, `${view}: admin edits everything`);
    assert.equal(isViewHidden(user, view), false, `${view}: admin is never hidden from a view`);
    assert.equal(canViewView(user, view), true, `${view}: admin opens everything`);
  }
  assert.equal(canEditView(user, "admin"), true);
  assert.equal(canViewView(user, "admin"), true);
});

// ── The admin-only screen ────────────────────────────────────────────────────

test("the admin screen is closed to viewers and operators", () => {
  assert.equal(canViewView(viewer(), "admin"), false);
  assert.equal(canViewView(operator(), "admin"), false);
  assert.equal(canEditView(operator(), "admin"), false);
  assert.equal(canViewView(admin(), "admin"), true);
});

// ── Why a page is read-only ──────────────────────────────────────────────────

test("the read-only reason separates a missing role from a missing grant", () => {
  for (const view of WRITABLE) {
    assert.equal(
      readOnlyReason(viewer(), view),
      "role",
      `${view}: a viewer is fenced by their role`
    );
    assert.equal(
      readOnlyReason(operator(), view),
      "feature-rule",
      `${view}: an operator with no row is fenced by the per-view grant`
    );
    assert.equal(
      readOnlyReason(operator({ [view]: DENIED }), view),
      "feature-rule",
      `${view}: an explicit denial is a per-view decision`
    );
    assert.equal(
      readOnlyReason(operator({ [view]: GRANTED }), view),
      null,
      `${view}: a granted operator is not read-only`
    );
    assert.equal(readOnlyReason(admin(), view), null, `${view}: an admin is never read-only`);
  }
});

// ── App-local screens carry no production row ────────────────────────────────

test("app-local screens can never match an imported permission row", () => {
  const user = operator({ "power-topology": GRANTED });
  assert.equal(storedPermission(user, "settings"), undefined);
  assert.equal(storedPermission(user, "admin"), undefined);
});
