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
const MAX_BODY_BYTES = 64 * 1024;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

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
    if (req.method !== "GET" && req.method !== "POST") {
      req.resume();
      res.writeHead(405, { allow: "GET, POST", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on("error", () => {});
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      received += c.length;
      if (received > MAX_BODY_BYTES) {
        // Refuse oversized bodies instead of buffering them (audit F-19).
        rejected = true;
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
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
            signature: first(req.headers["x-avaira-signature"]),
            "x-admin-signature": first(req.headers["x-avaira-admin-signature"]),
            "x-admin-timestamp": first(req.headers["x-avaira-admin-timestamp"]),
            "x-admin-nonce": first(req.headers["x-avaira-admin-nonce"]),
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
