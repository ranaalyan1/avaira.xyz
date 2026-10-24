/**
 * CLI entry. Two modes:
 *
 *   serve  — run the HTTP decision service (see server.ts header for routes)
 *   eval   — one-shot: ask the gate about an intent, print the decision, exit
 *
 * Configuration (env):
 *   GATEWAY_SEED          HMAC seed for per-agent keys (required)
 *   GATEWAY_ADMIN_SEED    HMAC seed for admin resets (required)
 *   GATEWAY_RPC_URL       defaults to the public Robinhood testnet RPC
 *   GATEWAY_MANIFEST      path to deployments/{chainId}.json (default: testnet)
 *   GATEWAY_PORT          listen port (default 8787)
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { RobinhoodGateClient, vaultFromManifest, reasonName } from "./gate.js";
import { Gateway, type ExecuteRequest } from "./server.js";

const DEFAULT_MANIFEST = "../../contracts/deployments/46630.json";

function loadManifest(path: string): { chainId: number; intentVault: string } {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (typeof m.intentVault !== "string" || typeof m.chainId !== "number") {
    throw new Error(`manifest ${path} has no intentVault/chainId — deploy first`);
  }
  return m;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} is not set — the gateway refuses to run unauthenticated.`);
    process.exit(1);
  }
  return v;
}

export function main(): void {
  const mode = process.argv[2] ?? "serve";
  const seed = requireEnv("GATEWAY_SEED");
  const adminSeed = requireEnv("GATEWAY_ADMIN_SEED");
  const rpcUrl = process.env.GATEWAY_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
  const manifestPath = process.env.GATEWAY_MANIFEST ?? DEFAULT_MANIFEST;
  const manifest = loadManifest(manifestPath);
  const gate = new RobinhoodGateClient({
    rpcUrl,
    chainId: manifest.chainId,
    vault: vaultFromManifest(manifest),
  });

  const gateway = new Gateway({ seed, adminSeed, gate });

  if (mode === "eval") {
    // eval is an operator tool that runs on the operator's own machine: it calls the
    // gate directly and skips the HTTP auth layer entirely (no seed needed).
    const agentId = requireEnv("AGENT_ID");
    const intentHash = requireEnv("INTENT_HASH");
    const envelopeHash = requireEnv("ENVELOPE_HASH");
    gate
      .check(BigInt(agentId), intentHash as `0x${string}`, envelopeHash as `0x${string}`)
      .then((d) => {
        console.log(
          `${d.allowed ? "ALLOWED" : "DENIED"}  score=${d.score}  reason=${reasonName(d.reason)}  latency=${d.latencyMs}ms`,
        );
      })
      .catch((err) => {
        console.error(`✗ gate unreachable: ${String(err)}`);
        process.exit(1);
      });
    return;
  }

  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: ExecuteRequest;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
        return;
      }
      gateway
        .handle(
          req.method === "GET" ? "GET" : "POST",
          req.url ?? "/",
          {
            signature: Array.isArray(req.headers["x-avaira-signature"])
              ? req.headers["x-avaira-signature"][0]
              : req.headers["x-avaira-signature"],
            "x-admin-signature": Array.isArray(req.headers["x-avaira-admin-signature"])
              ? req.headers["x-avaira-admin-signature"][0]
              : req.headers["x-avaira-admin-signature"],
          },
          body,
        )
        .then((out) => {
          res.writeHead(out.status, { "content-type": "application/json" });
          res.end(JSON.stringify(out.body));
        });
    });
  });
  server.listen(port, () => {
    console.log(`avaira gateway — vault ${gate.vaultAddress()} — listening on :${port}`);
  });
}

main();
