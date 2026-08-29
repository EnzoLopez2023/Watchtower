import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { BUILD_IDENTITY } from "../../lib/buildIdentity.js";

test("API and static build identities are identical and immutable", async () => {
  const staticIdentity = JSON.parse(await readFile("public/version.json", "utf8")) as unknown;
  assert.deepEqual(staticIdentity, BUILD_IDENTITY);
  assert.equal(
    BUILD_IDENTITY.source.commit,
    "f0b05fc1dbf53e8aa26c215d8e858894a2793871"
  );
  assert.equal(
    BUILD_IDENTITY.source.tree,
    "62cbd35861c511f7c17187c875d19ee6e353b80d"
  );
  assert.equal(
    BUILD_IDENTITY.source.imageDigest,
    "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140"
  );
  assert.equal(Object.isFrozen(BUILD_IDENTITY), true);
  assert.equal(Object.isFrozen(BUILD_IDENTITY.source), true);
  assert.equal(Object.isFrozen(BUILD_IDENTITY.source.database), true);
});
