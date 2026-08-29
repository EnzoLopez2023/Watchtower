/**
 * Typed, fail-closed errors for the legacy import / reconciliation layer.
 *
 * Every failure carries a stable machine code so scripts, evidence manifests and
 * tests can assert on the reason instead of message text.
 */

export type ImportErrorCode =
  | "ARGUMENT_INVALID"
  | "ARGUMENT_MISSING"
  | "MANIFEST_INVALID"
  | "MANIFEST_OWNERSHIP_DRIFT"
  | "BASELINE_REJECTED"
  | "SOURCE_MISSING"
  | "SOURCE_IDENTITY_MISMATCH"
  | "SOURCE_NOT_READABLE"
  | "SOURCE_SCHEMA_INCOMPLETE"
  | "SOURCE_MUTATED"
  | "TARGET_PATH_UNSAFE"
  | "TARGET_ALIASES_SOURCE"
  | "TARGET_IN_GIT_WORKTREE"
  | "TARGET_NOT_EMPTY"
  | "TARGET_SIDECAR_PRESENT"
  | "TARGET_PRAGMA_REJECTED"
  | "APP_LOCAL_SCHEMA_MISSING"
  | "APP_LOCAL_SCHEMA_INCOMPATIBLE"
  | "APP_LOCAL_MIGRATION_FAILED"
  | "TRANSFORM_UNMAPPED_ROW"
  | "DISPOSITION_UNKNOWN"
  | "DISPOSITION_NOT_APPROVED"
  | "COPY_ROW_COUNT_MISMATCH"
  | "SEQUENCE_MISMATCH"
  | "ORACLE_INVALID"
  | "ORACLE_MISMATCH"
  | "ORACLE_VALUE_UNSUPPORTED"
  | "ORACLE_GENERATOR_MISSING"
  | "ORACLE_GENERATOR_FAILED"
  | "RECONCILE_DIFFERENCES"
  | "EVIDENCE_INVALID";

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ImportErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (isImportError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED_ERROR", message: error.message };
  }
  return { code: "UNEXPECTED_ERROR", message: String(error) };
}
