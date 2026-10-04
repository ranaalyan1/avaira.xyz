import { test } from "node:test";
import assert from "node:assert/strict";

import { recoverMessageAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CleanverseClient, ccpDecrypt, ccpEncrypt, mockIdentityResult } from "../src/cleanverse.js";
import { buildCredentialHash, cviSignaturePayload } from "../src/onchain.js";
import { CviPipeline } from "../src/service.js";
import type { CviConfig } from "../src/config.js";
import type { OnchainSubmitter } from "../src/onchain.js";

const ISSUER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

function testConfig(): CviConfig {
  return {
    port: 0,
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 10143,
    chainName: "monad",
    gateAddress: "0x0000000000000000000000000000000000000001",
    issuerPrivateKey: ISSUER_PK,
    credentialTtlSeconds: 30 * 24 * 3600,
    cleanverseAppId: "app-test",
    cleanverseApiKey: Buffer.alloc(32, 7).toString("base64"),
    cleanverseBaseUrl: "http://ccp.invalid/api/cooperate",
    cleanverseMock: true,
  };
}

class RecordingSubmitter implements OnchainSubmitter {
  readonly issuerAddress = privateKeyToAccount(ISSUER_PK).address;
  submissions: Array<{ wallet: `0x${string}`; credentialHash: Hex; expiry: bigint; signature: Hex }> = [];

  async signPayload(payload: Hex): Promise<Hex> {
    return privateKeyToAccount(ISSUER_PK).signMessage({ message: { raw: payload } });
  }

  async submitVerifyCvi(args: { wallet: `0x${string}`; credentialHash: Hex; expiry: bigint; signature: Hex }) {
    this.submissions.push(args);
    return { txHash: keccak256(toHex(`tx-${this.submissions.length}`)) };
  }
}

test("ccpEncrypt/ccpDecrypt round-trip matches the CCP envelope", () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const secret = JSON.stringify({ wallet: { chain: "monad", address: "0xabc" }, tier: 2 });
  const ciphertext = ccpEncrypt(secret, key);
  assert.notEqual(ciphertext, secret);
  assert.equal(ccpDecrypt(ciphertext, key), secret);
});

test("mock CCP verifies ordinary wallets and rejects flagged ones", () => {
  assert.equal(mockIdentityResult("0x1111111111111111111111111111111111111111").verified, true);
  assert.equal(mockIdentityResult("0xDead000000000000000000000000000000000000").verified, false);
});

test("pipeline: verified identity produces an issuer-signed on-chain credential", async () => {
  const config = testConfig();
  const wallet = "0x1111111111111111111111111111111111111111" as const;
  const ccp = new CleanverseClient({
    baseUrl: config.cleanverseBaseUrl,
    appId: config.cleanverseAppId,
    apiKey: config.cleanverseApiKey,
    mock: true,
  });
  const submitter = new RecordingSubmitter();
  const pipeline = new CviPipeline(ccp, submitter, config);

  const outcome = await pipeline.verify(wallet);

  assert.equal(outcome.verified, true);
  assert.ok(outcome.credentialHash);
  assert.ok(outcome.txHash);
  assert.equal(submitter.submissions.length, 1);

  const submission = submitter.submissions[0]!;
  assert.equal(submission.wallet, wallet);
  assert.equal(submission.credentialHash, outcome.credentialHash);

  // The signature must recover to the issuer over the exact payload the gate checks.
  const payload = cviSignaturePayload(wallet, submission.credentialHash, submission.expiry);
  const recovered = await recoverMessageAddress({ message: { raw: payload }, signature: submission.signature });
  assert.equal(recovered, submitter.issuerAddress);

  // Expiry respects the configured TTL.
  const now = Math.floor(Date.now() / 1000);
  assert.ok(submission.expiry > BigInt(now));
  assert.ok(submission.expiry <= BigInt(now + config.credentialTtlSeconds + 5));
});

test("pipeline: unverified identity never touches the chain", async () => {
  const config = testConfig();
  const ccp = new CleanverseClient({
    baseUrl: config.cleanverseBaseUrl,
    appId: config.cleanverseAppId,
    apiKey: config.cleanverseApiKey,
    mock: true,
  });
  const submitter = new RecordingSubmitter();
  const pipeline = new CviPipeline(ccp, submitter, config);

  const outcome = await pipeline.verify("0xDead000000000000000000000000000000000000");
  assert.equal(outcome.verified, false);
  assert.equal(outcome.txHash, undefined);
  assert.equal(submitter.submissions.length, 0);
});

test("credential hash commits to wallet, CCP record and issuance time", () => {
  const wallet = "0x2222222222222222222222222222222222222222" as const;
  const ccp = mockIdentityResult(wallet);
  const a = buildCredentialHash(wallet, ccp, 1000);
  const b = buildCredentialHash(wallet, ccp, 1001);
  assert.notEqual(a, b, "issuance time must be committed");
  assert.equal(a, buildCredentialHash(wallet, ccp, 1000), "deterministic for identical inputs");
});

test("createApp: validates wallet input on /verify and reports health", async () => {
  const { createApp } = await import("../src/index.js");
  const config = testConfig();
  const ccp = new CleanverseClient({
    baseUrl: config.cleanverseBaseUrl,
    appId: config.cleanverseAppId,
    apiKey: config.cleanverseApiKey,
    mock: true,
  });
  const submitter = new RecordingSubmitter();
  const app = createApp(config, { pipeline: new CviPipeline(ccp, submitter, config) });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; ccp: string };
    assert.equal(health.ok, true);
    assert.equal(health.ccp, "mock");

    const bad = await fetch(`${base}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "not-an-address" }),
    });
    assert.equal(bad.status, 400);

    const good = await fetch(`${base}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "0x3333333333333333333333333333333333333333" }),
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { verified: boolean; txHash?: string };
    assert.equal(body.verified, true);
    assert.ok(body.txHash);

    const rejected = await fetch(`${base}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "0xDead000000000000000000000000000000000000" }),
    });
    assert.equal(rejected.status, 422);
  } finally {
    server.close();
  }
});
