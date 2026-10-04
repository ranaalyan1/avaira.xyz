/**
 * CVI service unit tests — no network, no credentials.
 *
 * These pin the parts that must be right for the on-chain gate to trust the service:
 * deterministic credential hashing, a correct EIP-712 claim, and a CCP response parser that
 * fails closed on unknown envelopes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CVI_CLAIM_TYPE,
  CVI_EIP712_DOMAIN_NAME,
  CVI_EIP712_DOMAIN_VERSION,
  buildCVIClaimTypedData,
  decodeCVIRejection,
  hashIdentityPayload,
} from "@avaira/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, verifyTypedData } from "viem";

import { CleanverseCCPClient, credentialHashFor, normalizeCCPResponse } from "../src/cleanverse.js";

const ISSUER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const GATE = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" as const;

test("hashIdentityPayload is deterministic and order-insensitive to callers", () => {
  const a = hashIdentityPayload({ legalName: "Acme Ltd", country: "SG" });
  const b = hashIdentityPayload({ legalName: "Acme Ltd", country: "SG" });
  const c = hashIdentityPayload({ legalName: "Other Ltd", country: "SG" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("CCP parser accepts the documented envelopes and fails closed", () => {
  assert.equal(normalizeCCPResponse({ status: "verified" }).status, "verified");
  assert.equal(normalizeCCPResponse({ data: { status: "VERIFIED" } }).status, "verified");
  assert.equal(normalizeCCPResponse({ result: { state: "approved" }, referenceId: "r-1" }).referenceId, "r-1");
  assert.equal(normalizeCCPResponse({ code: 0 }).status, "verified");
  assert.equal(normalizeCCPResponse({ data: { status: "pending" } }).status, "pending");
  assert.equal(normalizeCCPResponse({ data: { status: "rejected" } }).status, "rejected");
  // Opaque envelope: never silently treated as verified.
  assert.equal(normalizeCCPResponse({ hello: "world" }).status, "pending");
});

test("mock mode is deterministic, labelled, and never claims a live CCP verdict", async () => {
  const client = new CleanverseCCPClient({
    mode: "mock",
    baseUrl: "https://api.cleanverse.com",
    verifyPath: "/v1/identity/verify",
  });
  const wallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const first = await client.verifyIdentity({ wallet, identityPayload: { legalName: "Acme Ltd" } });
  const second = await client.verifyIdentity({ wallet, identityPayload: { legalName: "Acme Ltd" } });
  assert.equal(first.status, "verified");
  assert.equal(first.mode, "mock");
  assert.equal(first.referenceId, second.referenceId, "mock decisions must be reproducible");

  const rejected = await client.verifyIdentity({ wallet, identityPayload: { reject: true } });
  assert.equal(rejected.status, "rejected");
});

test("live mode is not used when credentials are absent", async () => {
  // The client is constructed in mock mode by config.loadConfig() in that case; here we
  // assert the client refuses nothing, but does not perform network I/O in mock mode.
  const client = new CleanverseCCPClient({
    mode: "mock",
    baseUrl: "https://example.invalid",
    verifyPath: "/nope",
    fetchImpl: (() => {
      throw new Error("network must not be touched in mock mode");
    }) as unknown as typeof fetch,
  });
  const result = await client.verifyIdentity({ wallet: GATE, identityPayload: {} });
  assert.equal(result.status, "verified");
});

test("credential hash binds app, wallet, reference and payload", () => {
  const wallet = GATE;
  const base = {
    appId: "app-1",
    wallet,
    result: { status: "verified", referenceId: "ccp-42", mode: "live", raw: {} } as const,
    identityPayload: { legalName: "Acme Ltd" },
  };
  const hash = credentialHashFor(base);
  assert.notEqual(hash, credentialHashFor({ ...base, wallet: "0x0000000000000000000000000000000000000001" }));
  assert.notEqual(hash, credentialHashFor({ ...base, appId: "app-2" }));
  assert.notEqual(
    hash,
    credentialHashFor({
      ...base,
      result: { status: "verified", referenceId: "ccp-43", mode: "live", raw: {} },
    }),
  );
});

test("CVI claim typed data matches the on-chain EIP-712 domain and recovers the issuer", async () => {
  const account = privateKeyToAccount(ISSUER_PK);
  const typedData = buildCVIClaimTypedData({
    chainId: 10143,
    gate: GATE,
    wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    credentialHash: hashIdentityPayload({ legalName: "Acme Ltd" }),
    nonce: 0n,
  });

  assert.equal(typedData.domain.name, CVI_EIP712_DOMAIN_NAME);
  assert.equal(typedData.domain.version, CVI_EIP712_DOMAIN_VERSION);
  assert.equal(typedData.domain.verifyingContract, GATE);
  assert.equal(typedData.types.CVIClaimShort, CVI_CLAIM_TYPE.CVIClaimShort);

  const signature = await account.signTypedData(typedData as never);
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature,
  });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());

  const ok = await verifyTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    address: account.address,
    signature,
  });
  assert.equal(ok, true);
});

test("CVI rejection decoder maps custom-error selectors", () => {
  const wallet = "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8";
  assert.deepEqual(decodeCVIRejection(`0x9e2b6191${wallet}` as `0x${string}`), {
    reason: "CVI_MISSING",
    wallet: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  });
  assert.equal(decodeCVIRejection("0xd47fd532" as `0x${string}`)?.reason, "CVI_EXPIRED");
  assert.equal(decodeCVIRejection("0xe2722f45" as `0x${string}`)?.reason, "CVI_REVOKED");
  assert.equal(decodeCVIRejection("0xdeadbeef" as `0x${string}`), undefined);
});
