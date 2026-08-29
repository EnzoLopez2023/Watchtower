/**
 * Public surface of the Watchtower legacy import / reconciliation layer.
 *
 * Nothing here opens a database on import; every entry point takes explicit
 * paths so there are no hidden production locations.
 */

export { ImportError, isImportError, describeError, type ImportErrorCode } from "./errors.js";

export {
  EXPECTED_OWNED_TABLES,
  EXPECTED_OWNED_TABLE_COUNT,
  EXPECTED_OWNED_ROW_TOTAL,
  NEVER_COPIED_SHARED_TABLES,
  OWNED_API_PATH_PREFIXES,
  OWNED_VIEW_IDS,
  PRODUCT_NAME,
  SHARED_SOURCE_TABLES,
  isOwnedApiPath,
  isOwnedViewId,
  loadOwnershipContract,
  type OwnershipContract,
  type SourceBaselineIdentity
} from "./ownership.js";

export {
  APPROVED_AGGREGATE_SHA256,
  APPROVED_LINEAGE,
  APPROVED_OWNED_EXPLICIT_INDEX_COUNT,
  APPROVED_OWNED_ROW_TOTAL,
  APPROVED_OWNED_SCHEMA_DIGEST,
  APPROVED_OWNED_TABLES,
  APPROVED_OWNED_TABLE_COUNT,
  APPROVED_OWNED_TRIGGER_COUNT,
  APPROVED_SEQUENCES,
  APPROVED_SOURCE_SCHEMA_COUNTS,
  APPROVED_TABLES,
  type ApprovedLineage,
  type ApprovedTable
} from "./approvedBaseline.js";

export {
  assertBackupIdentityMatchesApprovedBaseline,
  assertManifestMatchesApprovedBaseline,
  assertOracleMatchesApprovedBaseline,
  assertOracleRequiredForProduct,
  assertSourceMatchesApprovedBaseline,
  isFullyAdmitted,
  readSourceSchemaFacts,
  UNADMITTED,
  type BaselineAdmission,
  type BaselineFinding,
  type SourceBaselineFacts,
  type SourceSchemaFacts
} from "./baselineGate.js";

export {
  BlobColumnDigest,
  CanonicalDigest,
  canonicalTypeOf,
  describeValue,
  encodeValue,
  hashRow,
  stableJsonDigest,
  stableStringify,
  type CanonicalType,
  type SqliteValue
} from "./canonical.js";

export {
  computeSchemaIdentity,
  orderByClause,
  quoteIdentifier,
  readOwnedSchemaObjects,
  readSequences,
  readTableSchema,
  selectColumnsClause,
  tableExists,
  type ColumnInfo,
  type ForeignKeyInfo,
  type IndexInfo,
  type IndexOrigin,
  type SchemaIdentity,
  type SchemaObject,
  type TableSchema
} from "./schema.js";

export {
  assertOwnedTablesPresent,
  assertSourceUnchanged,
  hashFile,
  openSourceReadonly,
  verifySourceFile,
  type SourceFileIdentity
} from "./sourceIdentity.js";

export {
  assertTargetPathSafe,
  finalizeTarget,
  findGitWorktreeRoot,
  openEmptyTarget,
  openTargetReadonly,
  type LoadSynchronous,
  type OpenTargetResult,
  type TargetOptions
} from "./target.js";

export {
  copySequences,
  copyTableRows,
  countRows,
  createOwnedIndexesAndTriggers,
  createOwnedTables,
  type CopyTableResult,
  type SchemaCopyResult
} from "./copy.js";

export {
  APP_AUDIT_LOG_TABLE,
  APP_FEATURE_PERMISSIONS_TABLE,
  APP_IDENTITIES_TABLE,
  APP_LOCAL_TABLES,
  APP_ROLE_GRANTS_TABLE,
  SCHEMA_MIGRATIONS_TABLE,
  assertMigrationIdentities,
  coreMigrationIdentities,
  ensureAppLocalSchema,
  expectedCoreSchema,
  type AppLocalSchemaMode,
  type AppLocalSchemaResult,
  type MigrationIdentity
} from "./appLocalSchema.js";

export {
  DISPOSITIONS,
  DispositionLedger,
  getDisposition,
  type Disposition,
  type DispositionCount,
  type DispositionKind
} from "./dispositions.js";

export {
  AUDIT_FIELD_LIMITS,
  assertOid,
  assertTenantId,
  parseLegacyUtcTimestamp,
  transformSharedTables,
  type IdentityTransformResult,
  type TransformOptions
} from "./transform.js";

export {
  fingerprintTable,
  reconcile,
  type BlobColumnResult,
  type ForeignKeyViolation,
  type ReconciliationResult,
  type TableDifference,
  type TableFingerprint
} from "./reconcile.js";

export {
  ORACLE_CONTRACT,
  ORACLE_PRODUCT_DOMAIN,
  ORACLE_TABLE_DOMAIN,
  WATCHTOWER_ORACLE_AGGREGATE_SHA256,
  WATCHTOWER_ORACLE_ROW_TOTAL,
  WATCHTOWER_ORACLE_TABLE_COUNT,
  assertOraclePublishesWatchtowerBaseline,
  computeOracleProductHash,
  computeOracleTableHash,
  loadOracle,
  verifyAgainstOracle,
  writeOracleValue,
  type OracleColumn,
  type OracleDifference,
  type OracleDocument,
  type OracleProductEntry,
  type OracleTableComparison,
  type OracleTableEntry,
  type OracleTableResult,
  type OracleVerification
} from "./oracle.js";

export {
  runExternalSourceOracle,
  type ExternalOracleProvenance,
  type ExternalOracleRun
} from "./externalOracle.js";

export {
  EVIDENCE_CONTRACT,
  EVIDENCE_CONTRACT_VERSION,
  buildEvidenceManifest,
  serializeEvidence,
  writeEvidence,
  type BuildEvidenceInput,
  type EvidenceManifest
} from "./evidence.js";

export {
  runImport,
  type ImportOptions,
  type ImportProgressEvent,
  type ImportRunResult,
  type ImportSummary
} from "./importer.js";

export {
  booleanOption,
  numberOrNull,
  optionalString,
  parseArguments,
  renderUsage,
  requireString,
  stringList,
  type OptionSpec,
  type ParsedOptions
} from "./cli.js";
