import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { EntraAccessTokenVerifier } from "../../server/auth/entra.js";
import { HttpError } from "../../server/http/errors.js";

const TENANT_ID = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
const CLIENT_ID = "55bf92db-2cec-4e65-ab0d-71bee90d7494";
const AUDIENCE = `api://${CLIENT_ID}`;
const OID = "d6c36f6e-054c-45b8-9468-16c208628814";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

const { privateKey, publicKey } = await generateKeyPair("RS256");

async function token(overrides: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: TENANT_ID,
    oid: OID,
    preferred_username: "operator@example.invalid",
    name: "Operator",
    scp: "access_as_user",
    ...overrides
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

function verifier() {
  return new EntraAccessTokenVerifier(
    {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      audience: AUDIENCE,
      configured: true
    },
    publicKey
  );
}

test("validates a Marquee-style Entra access token by tenant, issuer, audience and OID", async () => {
  const identity = await verifier().verify(await token());
  assert.equal(identity.tenantId, TENANT_ID);
  assert.equal(identity.oid, OID);
  assert.equal(identity.email, "operator@example.invalid");
  assert.deepEqual(identity.scopes, ["access_as_user"]);
});

test("rejects the wrong audience", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrongAudience = await new SignJWT({ tid: TENANT_ID, oid: OID })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience("api://another-app")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  await assert.rejects(
    verifier().verify(wrongAudience),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_access_token"
  );
});

test("rejects the wrong tenant even with a valid signature", async () => {
  await assert.rejects(
    verifier().verify(await token({ tid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_identity"
  );
});

test("rejects a non-GUID OID", async () => {
  await assert.rejects(
    verifier().verify(await token({ oid: "operator@example.invalid" })),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_identity"
  );
});

test("fails closed when Entra is unconfigured", async () => {
  const unconfigured = new EntraAccessTokenVerifier(
    {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      audience: AUDIENCE,
      configured: false
    },
    publicKey
  );
  await assert.rejects(
    unconfigured.verify(await token()),
    (error: unknown) => error instanceof HttpError && error.code === "auth_unconfigured"
  );
});

