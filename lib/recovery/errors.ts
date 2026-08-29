/**
 * Typed, fail-closed errors for the Watchtower recovery layer.
 */

export type RecoveryErrorCode =
  | "ARGUMENT_INVALID"
  | "ARGUMENT_MISSING"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_READABLE"
  | "BACKUP_DESTINATION_UNSAFE"
  | "BACKUP_DESTINATION_EXISTS"
  | "BACKUP_FAILED"
  | "BACKUP_QUICK_CHECK_FAILED"
  | "BACKUP_INTEGRITY_CHECK_FAILED"
  | "BACKUP_FOREIGN_KEY_CHECK_FAILED"
  | "BACKUP_MANIFEST_INVALID"
  | "BACKUP_MANIFEST_MISMATCH"
  | "BACKUP_BYTES_MISMATCH"
  | "BACKUP_SHA_MISMATCH"
  | "RESTORE_DESTINATION_UNSAFE"
  | "RESTORE_DESTINATION_EXISTS"
  | "RESTORE_VERIFICATION_FAILED"
  | "STORAGE_SHARED_CREDENTIAL_REJECTED"
  | "STORAGE_DEPENDENCY_MISSING"
  | "BLOB_CONFIGURATION_INVALID"
  | "BLOB_NAME_INVALID"
  | "BLOB_REQUEST_FAILED"
  | "BLOB_READBACK_MISMATCH";

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RecoveryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isRecoveryError(value: unknown): value is RecoveryError {
  return value instanceof RecoveryError;
}

export function describeRecoveryError(error: unknown): { code: string; message: string } {
  if (isRecoveryError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "UNEXPECTED_ERROR", message: error.message };
  return { code: "UNEXPECTED_ERROR", message: String(error) };
}
