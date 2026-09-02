import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REVIEWED_HEAD = "f45790e9df7c9fabbc53dd04e6055a59d6f28f39";
const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/deploy.yml", import.meta.url)
);
const ACTION_PATH = fileURLToPath(
  new URL("../../.github/actions/deployment-diagnostic/action.yml", import.meta.url)
);
const HELPER_PATH = fileURLToPath(
  new URL("../../scripts/deployment-diagnostic.mjs", import.meta.url)
);
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

function gitBlobSha(path: string): string {
  const contents = readFileSync(path);
  return createHash("sha1")
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest("hex");
}

function namedStep(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function diagnosticStep(checkId: string): string {
  const token = `          check-id: ${checkId}`;
  const tokenIndex = workflow.indexOf(token);
  if (tokenIndex === -1) throw new Error(`missing diagnostic check: ${checkId}`);
  const start = workflow.lastIndexOf("\n      - name:", tokenIndex);
  const next = workflow.indexOf("\n      - name:", tokenIndex);
  return workflow.slice(start + 1, next === -1 ? undefined : next);
}

function diagnosticCommand(checkId: string): string {
  const step = diagnosticStep(checkId);
  const marker = "          run: |\n";
  const start = step.indexOf(marker);
  if (start === -1) throw new Error(`missing run command for diagnostic: ${checkId}`);
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
}

function timeoutMinutes(step: string): number {
  const match = /^\s+timeout-minutes:\s*(\d+)\s*$/m.exec(step);
  if (!match) throw new Error("step has no timeout-minutes");
  return Number(match[1]);
}

test("the deployment diagnostics artifacts are byte-identical to the reviewed contract", () => {
  assert.equal(REVIEWED_HEAD, "f45790e9df7c9fabbc53dd04e6055a59d6f28f39");
  assert.equal(
    gitBlobSha(HELPER_PATH),
    "d31a00faad5832832bf0b91e96387f5f77645700",
    "deployment-diagnostic.mjs must stay verbatim from azure-infra PR #24"
  );
  assert.equal(
    gitBlobSha(ACTION_PATH),
    "ff7330e29f4f15abe61bf8c4f5520ff5f1674fc4",
    "action.yml must stay verbatim from azure-infra PR #24"
  );
});

test("every applicable deployment check is bound to structured non-blocking evidence", () => {
  const expected = [
    "aggregate",
    "image-sbom",
    "image-vulnerability-scan",
    "migration-compatibility-precheck",
    "monitoring-precheck",
    "protected-configuration-precheck",
    "provenance-attestation-verification",
    "readiness-precondition-precheck",
    "recovery-precondition-precheck",
    "signature-verification",
    "source-dependency-audit",
    "source-sbom"
  ];
  const actual = [
    ...workflow.matchAll(/^\s+check-id:\s*([a-z0-9-]+)\s*$/gm)
  ].map((match) => match[1]!).sort();

  assert.deepEqual(actual, expected);
  assert.match(
    workflow,
    /^\s+DIAGNOSTIC_RECORDS: deployment-diagnostics\/records\.jsonl$/m
  );
  for (const checkId of expected) {
    const step = diagnosticStep(checkId);
    assert.match(step, /uses: \.\/\.github\/actions\/deployment-diagnostic/);
    assert.match(step, /records: \$\{\{ env\.DIAGNOSTIC_RECORDS \}\}/);
    assert.ok(timeoutMinutes(step) > 0, `${checkId} must have a step timeout`);
  }
  assert.doesNotMatch(workflow, /^\s+mode:\s*skip\s*$/m);
  assert.doesNotMatch(workflow, /\.trivyignore|--ignorefile|--skip-(scan|audit|sbom|verify)/i);
});

test("existing dependency, SBOM, scanner, and Cosign strength is unchanged", () => {
  const dependencyAudit = diagnosticStep("source-dependency-audit");
  assert.match(
    dependencyAudit,
    /npm audit --omit=dev --audit-level=high --json > evidence\/npm-audit\.json/
  );
  assert.match(dependencyAudit, /report-format: npm-audit-json/);

  const sourceSbom = diagnosticStep("source-sbom");
  assert.match(
    sourceSbom,
    /npm sbom --sbom-format=cyclonedx > evidence\/source-sbom\.cdx\.json/
  );
  assert.match(sourceSbom, /report-format: cyclonedx-json/);

  const imageSbom = namedStep("Generate exact-image SBOM");
  assert.match(
    imageSbom,
    /uses: anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/
  );
  assert.match(imageSbom, /continue-on-error: true/);
  assert.equal(timeoutMinutes(imageSbom), 5);
  assert.match(imageSbom, /image: \$\{\{ steps\.image\.outputs\.ref \}\}/);
  assert.match(imageSbom, /format: spdx-json/);
  assert.match(imageSbom, /output-file: evidence\/image-sbom\.spdx\.json/);
  assert.match(imageSbom, /upload-artifact: false/);
  assert.match(imageSbom, /upload-release-assets: false/);
  const imageSbomRecord = diagnosticStep("image-sbom");
  assert.match(imageSbomRecord, /mode: record/);
  assert.match(
    imageSbomRecord,
    /exit-code: \$\{\{ steps\.image_sbom\.outcome == 'success' && '0' \|\| '1' \}\}/
  );
  assert.match(imageSbomRecord, /report-format: spdx-json/);

  const imageScan = namedStep(
    "Scan exact image for HIGH and CRITICAL vulnerabilities"
  );
  assert.match(
    imageScan,
    /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/
  );
  assert.match(imageScan, /continue-on-error: true/);
  assert.equal(timeoutMinutes(imageScan), 12);
  assert.match(imageScan, /image-ref: \$\{\{ steps\.image\.outputs\.ref \}\}/);
  assert.match(imageScan, /format: json/);
  assert.match(imageScan, /output: evidence\/trivy-image\.json/);
  assert.match(imageScan, /exit-code: '0'/);
  assert.match(imageScan, /ignore-unfixed: false/);
  assert.match(imageScan, /severity: HIGH,CRITICAL/);
  assert.match(imageScan, /scanners: vuln/);
  assert.match(imageScan, /timeout: 10m/);
  assert.match(diagnosticStep("image-vulnerability-scan"), /report-format: trivy-json/);

  const cosignInstall = namedStep("Install Cosign");
  assert.match(
    cosignInstall,
    /uses: sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/
  );
  assert.match(cosignInstall, /continue-on-error: true/);
  assert.equal(timeoutMinutes(cosignInstall), 3);

  const signature = diagnosticStep("signature-verification");
  assert.match(signature, /cosign sign --yes "\$IMAGE_REFERENCE"/);
  assert.match(signature, /cosign verify \\/);
  assert.match(signature, /--certificate-identity "\$workflow_identity"/);
  assert.match(
    signature,
    /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/
  );

  const attestations = diagnosticStep("provenance-attestation-verification");
  assert.match(
    attestations,
    /cosign attest --yes --predicate evidence\/provenance\.slsa\.json \\\n\s+--type slsaprovenance1 "\$IMAGE_REFERENCE"/
  );
  assert.match(
    attestations,
    /cosign attest --yes --predicate evidence\/image-sbom\.spdx\.json \\\n\s+--type spdxjson "\$IMAGE_REFERENCE"/
  );
  assert.match(attestations, /cosign verify-attestation --type slsaprovenance1/);
  assert.match(attestations, /cosign verify-attestation --type spdxjson/);
});

test("diagnostic runtime is bounded without consuming the deployment operation budget", () => {
  const checkIds = [
    "aggregate",
    "image-sbom",
    "image-vulnerability-scan",
    "migration-compatibility-precheck",
    "monitoring-precheck",
    "protected-configuration-precheck",
    "provenance-attestation-verification",
    "readiness-precondition-precheck",
    "recovery-precondition-precheck",
    "signature-verification",
    "source-dependency-audit",
    "source-sbom"
  ];
  const diagnosticBudget = checkIds
    .map((checkId) => timeoutMinutes(diagnosticStep(checkId)))
    .reduce((sum, timeout) => sum + timeout, 0)
    + timeoutMinutes(namedStep("Generate exact-image SBOM"))
    + timeoutMinutes(namedStep("Scan exact image for HIGH and CRITICAL vulnerabilities"))
    + timeoutMinutes(namedStep("Install Cosign"))
    + timeoutMinutes(namedStep("Upload nonsecret deployment and diagnostic evidence"));

  assert.ok(diagnosticBudget <= 75, `diagnostics can consume ${diagnosticBudget} minutes`);
  assert.match(workflow, /^\s{4}timeout-minutes: 120$/m);
  assert.ok(120 >= 40 + diagnosticBudget, "the original 40-minute operation budget is preserved");
});

test("deployment operations, post-activation verification, and rollback remain blocking", () => {
  const blockingSteps = [
    "Checkout exact source",
    "Set up Node",
    "Install exact dependencies",
    "Validate source and build",
    "Azure login with OIDC",
    "Capture prior release",
    "Build, push, and inspect digest-pinned candidate",
    "Arm rollback before production mutation",
    "Activate inspected digest as production release",
    "Verify the new digest is the live release",
    "Promote verified digest to :latest",
    "Confirm promoted release",
    "Restore prior release after failure or cancellation"
  ];
  for (const name of blockingSteps) {
    assert.doesNotMatch(
      namedStep(name),
      /continue-on-error:\s*true/,
      `${name} must remain blocking`
    );
  }

  const build = namedStep("Build, push, and inspect digest-pinned candidate");
  assert.ok(build.indexOf("docker push") < build.indexOf("docker inspect"));
  assert.match(build, /\[\[ "\$digest" =~ \^sha256:/);

  const activation = namedStep("Activate inspected digest as production release");
  assert.match(activation, /az webapp config container set/);
  assert.match(activation, /--container-image-name "\$IMAGE_REFERENCE"/);

  const verify = namedStep("Verify the new digest is the live release");
  assert.match(verify, /\[\[ "\$confirm" -ge "\$REQUIRED_CONFIRMATIONS" \]\]/);
  assert.match(verify, /\[\[ "\$pinned" == "DOCKER\|\$IMAGE_REFERENCE" \]\]/);

  const rollback = namedStep("Restore prior release after failure or cancellation");
  assert.match(
    rollback,
    /always\(\) && \(failure\(\) \|\| cancelled\(\)\) && env\.DEPLOYMENT_MUTATED == 'true'/
  );
  assert.match(rollback, /\[\[ "\$restored" -ge 3 \]\]/);
  assert.doesNotMatch(workflow, /^\s+needs:/m);
});

test("deployment evidence reports actual supply-chain diagnostic outcomes", () => {
  const evidence = namedStep("Record deployment evidence");
  assert.match(evidence, /SIGNATURE_DIAGNOSTIC_STATUS:/);
  assert.match(evidence, /PROVENANCE_DIAGNOSTIC_STATUS:/);
  assert.match(evidence, /signed: \(\$signatureStatus == "pass"\)/);
  assert.match(evidence, /provenanceAttested: \(\$provenanceStatus == "pass"\)/);
  assert.match(evidence, /sbomAttested: \(\$provenanceStatus == "pass"\)/);
  assert.match(evidence, /supplyChainDiagnostics:/);
  assert.doesNotMatch(
    evidence,
    /signed:\s*true|provenanceAttested:\s*true|sbomAttested:\s*true/
  );
});

test("recovery freshness and the custom-container invariant remain real checks", () => {
  const recovery = diagnosticStep("recovery-precondition-precheck");
  assert.match(recovery, /az storage blob list/);
  assert.match(recovery, /--auth-mode login/);
  assert.match(recovery, /az storage blob download/);
  assert.match(recovery, /watchtower\.sqlite-backup-manifest/);
  assert.match(recovery, /stale_threshold \* 3600/);
  assert.match(recovery, /import \{ restoreBundle, verifyBackup \}/);
  assert.match(recovery, /offhostReadBackVerified/);
  assert.match(recovery, /localBundleVerified/);
  assert.match(recovery, /disposableRestoreVerified/);

  const configuration = diagnosticStep("protected-configuration-precheck");
  assert.match(configuration, /linuxFxVersion:linuxFxVersion/);
  assert.match(configuration, /customContainerConfigured:/);
  assert.match(configuration, /startswith\("DOCKER\|"\)/);
  assert.match(configuration, /\.siteInvariants\.customContainerConfigured == true/);
  assert.doesNotMatch(configuration, /\.value\b/);
});

test("aggregation and upload are best-effort, always-run, and loudly annotated", () => {
  const aggregate = namedStep("Aggregate deployment diagnostics");
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /continue-on-error: true/);
  assert.match(aggregate, /mode: aggregate/);

  const upload = namedStep(
    "Upload nonsecret deployment and diagnostic evidence"
  );
  assert.match(upload, /if: \$\{\{ always\(\) \}\}/);
  assert.match(upload, /continue-on-error: true/);
  assert.match(
    upload,
    /name: deployment-diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(upload, /deployment-diagnostics\//);
  assert.match(upload, /evidence\//);
  assert.match(upload, /retention-days: 30/);

  assert.match(
    namedStep("Warn when diagnostic aggregation cannot complete"),
    /::warning title=Deployment diagnostics aggregation::/
  );
  assert.match(
    namedStep("Warn when deployment evidence cannot be uploaded"),
    /::warning title=Deployment diagnostics upload::/
  );
});

function runPrecheck(args: {
  readonly checkId: string;
  readonly response: unknown;
  readonly report: string;
  readonly raw: string;
}): {
  readonly status: number | null;
  readonly reportExists: boolean;
  readonly rawExists: boolean;
  readonly stderr: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "watchtower-precheck-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "evidence"));
    const curl = join(bin, "curl");
    const node = join(bin, "node");
    writeFileSync(curl, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_RESPONSE\"\n");
    writeFileSync(node, "#!/bin/sh\nprintf '2'\n");
    chmodSync(curl, 0o755);
    chmodSync(node, 0o755);

    const result = spawnSync("bash", ["-c", diagnosticCommand(args.checkId)], {
      cwd: directory,
      encoding: "utf8",
      env: {
        FAKE_RESPONSE: JSON.stringify(args.response),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "1",
        HTTP_TIMEOUT_SECONDS: "8",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PRODUCTION_URL: "https://watchtower.example",
        READY_PATH: "/api/ready"
      }
    });
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      reportExists: existsSync(join(directory, args.report)),
      rawExists: existsSync(join(directory, args.raw)),
      stderr: result.stderr
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("migration and readiness prechecks reject incomplete response shapes before reporting", () => {
  const malformedMigration = runPrecheck({
    checkId: "migration-compatibility-precheck",
    response: { ok: true, authority: { schemaVersion: 2 } },
    report: "evidence/migration-compatibility.json",
    raw: "evidence/migration-compatibility.raw"
  });
  assert.notEqual(malformedMigration.status, 0, malformedMigration.stderr);
  assert.equal(malformedMigration.rawExists, true);
  assert.equal(malformedMigration.reportExists, false);

  const digest = "a".repeat(64);
  const validMigration = runPrecheck({
    checkId: "migration-compatibility-precheck",
    response: {
      ok: true,
      authority: {
        schemaVersion: 2,
        ownedSchemaDigest: digest,
        expectedOwnedSchemaDigest: digest
      }
    },
    report: "evidence/migration-compatibility.json",
    raw: "evidence/migration-compatibility.raw"
  });
  assert.equal(validMigration.status, 0, validMigration.stderr);
  assert.equal(validMigration.reportExists, true);

  const malformedReadiness = runPrecheck({
    checkId: "readiness-precondition-precheck",
    response: { ok: true, lifecycle: "ready" },
    report: "evidence/readiness-precheck.json",
    raw: "evidence/readiness-precheck.raw"
  });
  assert.notEqual(malformedReadiness.status, 0, malformedReadiness.stderr);
  assert.equal(malformedReadiness.rawExists, true);
  assert.equal(malformedReadiness.reportExists, false);

  const validReadiness = runPrecheck({
    checkId: "readiness-precondition-precheck",
    response: {
      ok: true,
      lifecycle: "ready",
      authority: { journalMode: "delete", schemaVersion: 2 },
      workers: { instanceLease: { state: "healthy" } }
    },
    report: "evidence/readiness-precheck.json",
    raw: "evidence/readiness-precheck.raw"
  });
  assert.equal(validReadiness.status, 0, validReadiness.stderr);
  assert.equal(validReadiness.reportExists, true);
});

interface DiagnosticRecord {
  readonly control_effect: string;
  readonly status: string;
  readonly exit_code: number | null;
  readonly execution_error?: string;
}

function recordResult(args: {
  readonly report: string;
  readonly reportContents?: string;
  readonly exitCode: number;
}): {
  readonly record: DiagnosticRecord;
  readonly output: string;
  readonly summary: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "watchtower-diagnostic-"));
  try {
    if (args.reportContents !== undefined) {
      writeFileSync(join(directory, args.report), args.reportContents);
    }
    const summaryPath = join(directory, "summary.md");
    const outputPath = join(directory, "outputs.txt");
    const result = spawnSync(
      process.execPath,
      [
        HELPER_PATH,
        "record",
        "--check",
        "contract-test",
        "--category",
        "source-audit",
        "--phase",
        "pre-build",
        "--records",
        "records.jsonl",
        "--report",
        args.report,
        "--report-format",
        "generic-json",
        "--exit-code",
        String(args.exitCode)
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_JOB: "test",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REF: "refs/heads/test",
          GITHUB_REPOSITORY: "EnzoLopez2023/Watchtower",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "1",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_STEP_SUMMARY: summaryPath
        }
      }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(join(directory, "records.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 1);
    return {
      record: JSON.parse(lines[0]!) as DiagnosticRecord,
      output: result.stdout,
      summary: readFileSync(summaryPath, "utf8")
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("missing and malformed reports are execution failures, never passes", () => {
  for (const sample of [
    { report: "missing.json", exitCode: 0 },
    { report: "malformed.json", reportContents: "{not-json", exitCode: 0 }
  ]) {
    const result = recordResult(sample);
    assert.equal(result.record.control_effect, "observable");
    assert.equal(result.record.status, "execution-failure");
    assert.match(result.record.execution_error ?? "", /could not be read|not valid JSON/);
    assert.match(result.output, /::warning title=Deployment diagnostics:/);
    assert.match(result.summary, /\*\*execution-failure\*\*/);
  }
});

test("a checker finding is retained without failing the helper action", () => {
  const result = recordResult({
    report: "finding.json",
    reportContents: "{}\n",
    exitCode: 7
  });
  assert.equal(result.record.control_effect, "observable");
  assert.equal(result.record.status, "finding");
  assert.equal(result.record.exit_code, 7);
  assert.match(result.output, /non-blocking; deferred remediation/);
  assert.match(result.summary, /\*\*finding\*\*/);
});
