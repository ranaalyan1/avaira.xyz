/**
 * @avaira/cvi-service — off-chain Cleanverse CVI verification service.
 *
 * Flow: POST /verify { wallet } ->
 *   1. Cleanverse CCP `query_apass` confirms the wallet-bound verified identity
 *   2. the service builds credentialHash = keccak256(wallet ‖ CCP-record-hash ‖ issuedAt)
 *   3. the Cleanverse issuer key signs (wallet, credentialHash, expiry) per EIP-191
 *   4. verifyCVI(wallet, credentialHash, expiry, issuerSignature) is submitted on-chain
 *
 * Identity verification is therefore the *cause* of the on-chain CVI credential, and
 * AvairaComplianceGate.gateCVATransfer reverts any CVA movement until it exists.
 */
import "dotenv/config";
import express, { type Express } from "express";

import { CleanverseClient } from "./cleanverse.js";
import { loadConfig, type CviConfig } from "./config.js";
import { GateReader, ViemSubmitter, type OnchainSubmitter } from "./onchain.js";
import { CviPipeline } from "./service.js";

const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

export function createApp(
  config: CviConfig,
  deps: { pipeline: CviPipeline; reader?: GateReader },
): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      chainId: config.chainId,
      gate: config.gateAddress,
      ccp: config.cleanverseMock ? "mock" : config.cleanverseBaseUrl,
    });
  });

  /** Verifies an entity's identity via the CCP and registers the CVI on-chain. */
  app.post("/verify", async (req, res) => {
    const wallet = req.body?.wallet;
    if (!isAddress(wallet)) {
      res.status(400).json({ error: "wallet must be a 0x-prefixed 20-byte address" });
      return;
    }
    try {
      const outcome = await deps.pipeline.verify(wallet);
      res.status(outcome.verified ? 200 : 422).json(outcome);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** On-chain CVI credential state for a wallet (drives the dashboard). */
  app.get("/credential/:wallet", async (req, res) => {
    const wallet = req.params.wallet;
    if (!isAddress(wallet)) {
      res.status(400).json({ error: "invalid wallet address" });
      return;
    }
    if (!deps.reader) {
      res.status(503).json({ error: "chain reader unavailable" });
      return;
    }
    try {
      const { status, credential } = await deps.reader.statusOf(wallet);
      res.json({ wallet, status, credential });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Travel-Rule preflight for a CVA transfer (non-reverting view). */
  app.get("/transfer-check/:from/:to", async (req, res) => {
    const { from, to } = req.params;
    if (!isAddress(from) || !isAddress(to)) {
      res.status(400).json({ error: "invalid from/to address" });
      return;
    }
    if (!deps.reader) {
      res.status(503).json({ error: "chain reader unavailable" });
      return;
    }
    try {
      res.json(await deps.reader.checkTransfer(from, to));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

/* istanbul ignore next -- process entrypoint */
async function main(): Promise<void> {
  const config = loadConfig();
  const ccp = new CleanverseClient({
    baseUrl: config.cleanverseBaseUrl,
    appId: config.cleanverseAppId,
    apiKey: config.cleanverseApiKey,
    mock: config.cleanverseMock,
  });
  const submitter: OnchainSubmitter = new ViemSubmitter(config);
  const pipeline = new CviPipeline(ccp, submitter, config);
  const reader = new GateReader(config);
  const app = createApp(config, { pipeline, reader });

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[cvi-service] listening on :${config.port} — gate ${config.gateAddress}, issuer ${submitter.issuerAddress}, ccp ${
        config.cleanverseMock ? "MOCK" : config.cleanverseBaseUrl
      }`,
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cvi-service] fatal:", err);
    process.exit(1);
  });
}
