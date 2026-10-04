#!/usr/bin/env tsx
/**
 * Avaira CVI service CLI.
 *
 *   npm start                 # serve POST /verify + GET /credential/:wallet
 *   npm run verify  -- --wallet 0x.. --name "Acme Ltd" --country SG
 *   npm run revoke  -- --wallet 0x..
 *   npm run status  -- --wallet 0x..
 */
import { CVIStatus, CVI_STATUS_TEXT } from "@avaira/sdk";

import { loadConfig } from "./config.js";
import { createCVIServer } from "./server.js";
import { CVIService } from "./service.js";

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const config = loadConfig();
  const service = new CVIService(config);

  if (command === "serve") {
    const server = createCVIServer(config, service);
    const host = process.env.CVI_HOST ?? "0.0.0.0";
    server.listen(config.port, host, () => {
      console.log(`Avaira CVI service listening on http://${host}:${config.port}`);
      console.log(`  mode            : ${config.mode}${config.mode === "mock" ? " (no CCP credentials: deterministic local decisions)" : ""}`);
      console.log(`  chain           : ${config.chainId} @ ${config.rpcUrl}`);
      console.log(`  compliance gate : ${config.complianceGate}`);
      console.log(`  CVA token       : ${config.cvaToken ?? "(none in manifest)"}`);
      console.log(`  routes          : POST /verify · GET /credential/:wallet · GET /status · GET /health`);
    });
    return;
  }

  if (command === "verify") {
    const wallet = flag("wallet") as `0x${string}` | undefined;
    if (!wallet) throw new Error("usage: npm run verify -- --wallet 0x... [--name 'Acme Ltd'] [--country SG] [--id REG123]");
    const outcome = await service.verify({
      wallet,
      identityPayload: {
        legalName: flag("name"),
        country: flag("country"),
        registrationId: flag("id"),
      },
    });
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.error) process.exitCode = 1;
    return;
  }

  if (command === "revoke") {
    const wallet = flag("wallet") as `0x${string}` | undefined;
    if (!wallet) throw new Error("usage: npm run revoke -- --wallet 0x...");
    const txHash = await service.revoke(wallet);
    console.log(JSON.stringify({ wallet, revoked: true, txHash }, null, 2));
    return;
  }

  if (command === "status") {
    const wallet = flag("wallet") as `0x${string}` | undefined;
    if (!wallet) throw new Error("usage: npm run status -- --wallet 0x...");
    const status = await service.statusOf(wallet);
    console.log(
      JSON.stringify({ wallet, status, statusText: CVI_STATUS_TEXT[status as CVIStatus] }, null, 2),
    );
    return;
  }

  throw new Error(`unknown command ${command} (serve | verify | revoke | status)`);
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
