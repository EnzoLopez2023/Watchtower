import assert from "node:assert/strict";
import test from "node:test";
import { canEditView as serverCanEdit, isViewVisible } from "../../server/auth/featureAccess.js";
import { OWNED_VIEW_IDS } from "../../lib/db/import/ownership.js";
import type { AppIdentity, AppRole } from "../../lib/db/repositories/identityRepository.js";

type Row = { readonly canEdit: boolean; readonly isHidden: boolean };

/**
 * The client module lives in the Vite project, which the server tsconfig does
 * not include. Loading it through a computed specifier keeps it out of this
 * project's file graph while still executing the real implementation — the
 * point of the test is that the shipped rules agree, not that the two projects
 * share a compilation unit.
 */
interface ClientPermissions {
  readonly canEditView: (subject: PermissionSubject, view: string) => boolean;
}

interface PermissionSubject {
  readonly roles: readonly string[];
  readonly featurePermissions: Readonly<Record<string, Row>>;
}

const clientModuleUrl = new URL("../../src/services/permissions.ts", import.meta.url).href;
const client = (await import(clientModuleUrl)) as ClientPermissions;
const clientCanEdit = client.canEditView;

/**
 * The client decides which affordances to render; the server decides what it
 * will accept. If those two rule sets drift, the UI either offers a button that
 * 403s or hides one the server would have allowed. Both implementations are
 * executed here over the same matrix so a change to one without the other
 * fails.
 */

const ROLE_SETS: readonly (readonly AppRole[])[] = [
  [],
  ["viewer"],
  ["viewer", "operator"],
  ["viewer", "operator", "admin"],
  ["operator"],
  ["admin"]
];

const ROWS: readonly (Row | undefined)[] = [
  undefined,
  { canEdit: false, isHidden: false },
  { canEdit: true, isHidden: false },
  { canEdit: false, isHidden: true },
  { canEdit: true, isHidden: true }
];

function serverSubject(roles: readonly AppRole[], view: string, row: Row | undefined): AppIdentity {
  return {
    tenantId: "t",
    oid: "o",
    roles: [...roles],
    featurePermissions: row ? { [view]: row } : {},
    firstSeenAt: 0,
    lastSeenAt: 0
  };
}

function clientSubject(roles: readonly AppRole[], view: string, row: Row | undefined): PermissionSubject {
  return { roles: [...roles], featurePermissions: row ? { [view]: row } : {} };
}

test("client and server agree on every edit decision across the full matrix", () => {
  const disagreements: string[] = [];
  let checked = 0;
  for (const view of OWNED_VIEW_IDS) {
    for (const roles of ROLE_SETS) {
      for (const row of ROWS) {
        const server = serverCanEdit(serverSubject(roles, view, row), view);
        const clientDecision = clientCanEdit(clientSubject(roles, view, row), view);
        checked += 1;
        if (server !== clientDecision) {
          disagreements.push(
            `${view} roles=[${roles.join(",")}] row=${JSON.stringify(row)} server=${server} client=${clientDecision}`
          );
        }
      }
    }
  }
  assert.equal(checked, OWNED_VIEW_IDS.length * ROLE_SETS.length * ROWS.length);
  assert.deepEqual(disagreements, [], "the UI would offer a write the server refuses, or vice versa");
});

test("no combination without an explicit canEdit row authorises a write", () => {
  for (const view of OWNED_VIEW_IDS) {
    for (const roles of ROLE_SETS) {
      if (roles.includes("admin")) continue;
      for (const row of [undefined, { canEdit: false, isHidden: false }] as const) {
        assert.equal(
          serverCanEdit(serverSubject(roles, view, row), view),
          false,
          `${view} granted a write with roles=[${roles.join(",")}] and row=${JSON.stringify(row)}`
        );
      }
    }
  }
});

test("visibility defaults to Hearth's visible when no row was imported", () => {
  for (const view of OWNED_VIEW_IDS) {
    assert.equal(
      isViewVisible(serverSubject(["viewer"], view, undefined), view),
      true,
      `${view} must stay visible when the import materialised no row`
    );
  }
});
