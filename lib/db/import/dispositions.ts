/**
 * Reviewed dispositions for rows that are not copied verbatim.
 *
 * The importer fails closed: any row it cannot map must match a disposition that
 * is registered here. Unregistered situations raise `TRANSFORM_UNMAPPED_ROW`.
 * Dispositions with `approved: false` additionally require an explicit
 * `--allow-disposition <code>` acknowledgement on the command line.
 */

import { ImportError } from "./errors.js";

export type DispositionKind =
  | "skip" // row is intentionally not migrated
  | "retain" // row is migrated with a documented, lossy or defaulted field
  | "reject"; // row is a hard failure unless explicitly acknowledged

export interface Disposition {
  readonly code: string;
  readonly kind: DispositionKind;
  readonly subject: string;
  readonly rationale: string;
  /** `true` when the disposition is pre-approved and needs no CLI acknowledgement. */
  readonly approved: boolean;
}

export const DISPOSITIONS: readonly Disposition[] = Object.freeze([
  {
    code: "hearth_index_not_migrated",
    kind: "skip",
    subject: "hearth_index",
    rationale:
      "Manifest disposition: the shared embedding index is not migrated as authority. Watchtower rebuilds app-local indexes and uses APIs for cross-app search.",
    approved: true
  },
  {
    code: "identity_missing_oid",
    kind: "reject",
    subject: "hearth_users",
    rationale:
      "An identity without a GUID-shaped azure_oid cannot be keyed by (tenant_id, oid). Email is never an authorization key, so the row cannot be migrated safely.",
    approved: false
  },
  {
    code: "permission_not_watchtower_feature",
    kind: "skip",
    subject: "hearth_permissions",
    rationale:
      "The feature is owned by another extracted product. Watchtower must not hold authorization state for features it does not serve.",
    approved: true
  },
  {
    code: "permission_orphan_identity",
    kind: "reject",
    subject: "hearth_permissions",
    rationale:
      "The permission references a hearth_users row that produced no app-local identity, so the grant has no verifiable subject.",
    approved: false
  },
  {
    code: "permission_default_retained",
    kind: "skip",
    subject: "hearth_permissions",
    rationale:
      "Hearth treats a missing permission row as visible and read-only. Watchtower keeps that default rather than materialising synthetic rows.",
    approved: true
  },
  {
    code: "audit_not_watchtower_scope",
    kind: "skip",
    subject: "audit_log",
    rationale:
      "The audit row belongs to another product: its view id is not one of the 11 Watchtower views and its path is not served by a Watchtower route module.",
    approved: true
  },
  {
    code: "audit_global_auth_event",
    kind: "skip",
    subject: "audit_log",
    rationale:
      "Monolith sign-in/sign-out events describe the shared Hearth registration, not the Watchtower app registration. Watchtower records its own auth events from first boot.",
    approved: true
  },
  {
    code: "audit_unmapped_actor",
    kind: "retain",
    subject: "audit_log",
    rationale:
      "The audit row is Watchtower-owned but its user_oid has no app-local identity. The row is retained as historical evidence with the OID preserved verbatim and no identity link.",
    approved: true
  },
  {
    code: "audit_field_truncated",
    kind: "retain",
    subject: "audit_log",
    rationale:
      "app_audit_log fields are bounded by the same limits the runtime audit repository applies on write (action 160, view 80, method 12, path 512, detail 1000, ip 128). A longer legacy value is truncated to the runtime bound and counted.",
    approved: true
  },
  {
    code: "audit_verified_flag_normalised",
    kind: "retain",
    subject: "audit_log",
    rationale:
      "app_audit_log constrains verified to 0/1. Any other truthy legacy value is normalised to 1 and counted.",
    approved: true
  }
]);

const BY_CODE = new Map(DISPOSITIONS.map((disposition) => [disposition.code, disposition]));

export function getDisposition(code: string): Disposition {
  const disposition = BY_CODE.get(code);
  if (!disposition) {
    throw new ImportError("DISPOSITION_UNKNOWN", `No reviewed disposition is registered for ${code}`, { code });
  }
  return disposition;
}

export interface DispositionCount {
  readonly code: string;
  readonly kind: DispositionKind;
  readonly subject: string;
  readonly rationale: string;
  readonly approved: boolean;
  readonly rows: number;
  readonly samples: readonly unknown[];
}

const MAX_SAMPLES = 10;

/** Accumulates disposition counts and bounded samples during a transform. */
export class DispositionLedger {
  readonly #counts = new Map<string, { rows: number; samples: unknown[] }>();
  readonly #acknowledged: ReadonlySet<string>;

  constructor(acknowledged: readonly string[] = []) {
    for (const code of acknowledged) getDisposition(code);
    this.#acknowledged = new Set(acknowledged);
  }

  record(code: string, sample?: unknown): Disposition {
    const disposition = getDisposition(code);
    let entry = this.#counts.get(code);
    if (!entry) {
      entry = { rows: 0, samples: [] };
      this.#counts.set(code, entry);
    }
    entry.rows += 1;
    if (sample !== undefined && entry.samples.length < MAX_SAMPLES) entry.samples.push(sample);
    return disposition;
  }

  /** Throws when an unapproved disposition fired without CLI acknowledgement. */
  assertAllApproved(): void {
    const blocking: { code: string; rows: number; rationale: string }[] = [];
    for (const [code, entry] of this.#counts) {
      if (entry.rows === 0) continue;
      const disposition = getDisposition(code);
      if (disposition.approved || this.#acknowledged.has(code)) continue;
      blocking.push({ code, rows: entry.rows, rationale: disposition.rationale });
    }
    if (blocking.length > 0) {
      throw new ImportError(
        "DISPOSITION_NOT_APPROVED",
        "Rows hit dispositions that require an explicit --allow-disposition acknowledgement",
        { dispositions: blocking.sort((a, b) => a.code.localeCompare(b.code)) }
      );
    }
  }

  summary(): DispositionCount[] {
    const rows: DispositionCount[] = [];
    for (const [code, entry] of this.#counts) {
      const disposition = getDisposition(code);
      rows.push({
        code,
        kind: disposition.kind,
        subject: disposition.subject,
        rationale: disposition.rationale,
        approved: disposition.approved || this.#acknowledged.has(code),
        rows: entry.rows,
        samples: Object.freeze([...entry.samples])
      });
    }
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  }

  get acknowledged(): readonly string[] {
    return [...this.#acknowledged].sort();
  }
}
