/**
 * Avaira CVI service HTTP surface.
 *
 *   POST /verify            { wallet, identityPayload }  → CCP verify + on-chain credential
 *   GET  /credential/:wallet                              → current credential record
 *   GET  /status                                          → service + deployment summary
 *   GET  /health                                          → liveness for the gateway/dashboard
 *
 * Plain `node:http`: this service is small, and fewer dependencies means fewer surprises
 * when a judge runs it minutes before a demo.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CVIStatus, CVI_STATUS_TEXT } from "@avaira/sdk";

import type { CVIConfig } from "./config.js";
import { CVIService } from "./service.js";

const MAX_BODY_BYTES = 256 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function createCVIServer(config: CVIConfig, service = new CVIService(config)) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }

    try {
      // ── GET /health ────────────────────────────────────────────────────────────────
      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        json(response, 200, {
          ok: true,
          service: "avaira-cvi",
          mode: config.mode,
          chainId: config.chainId,
          complianceGate: config.complianceGate,
        });
        return;
      }

      // ── GET /status ────────────────────────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/status") {
        json(response, 200, {
          mode: config.mode,
          chainId: config.chainId,
          rpcUrl: config.rpcUrl,
          complianceGate: config.complianceGate,
          cvaToken: config.cvaToken ?? null,
          issuerConfigured: Boolean(config.issuerPrivateKey),
          cleanverseConfigured: Boolean(config.cleanverseAppId && config.cleanverseApiKey),
          credentialValiditySeconds: config.credentialValiditySeconds,
          statuses: Object.fromEntries(
            Object.entries(CVI_STATUS_TEXT).map(([code, text]) => [CVIStatus[Number(code)], text]),
          ),
        });
        return;
      }

      // ── GET /credential/:wallet ────────────────────────────────────────────────────
      if (request.method === "GET" && url.pathname.startsWith("/credential/")) {
        const wallet = url.pathname.slice("/credential/".length) as `0x${string}`;
        if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
          json(response, 400, { error: "expected a 20-byte hex wallet address" });
          return;
        }
        const [credential, status] = await Promise.all([
          service.credentialOf(wallet),
          service.statusOf(wallet),
        ]);
        json(response, 200, {
          wallet,
          status,
          statusText: CVI_STATUS_TEXT[status as CVIStatus] ?? "unknown",
          credential,
        });
        return;
      }

      // ── POST /verify ───────────────────────────────────────────────────────────────
      if (request.method === "POST" && url.pathname === "/verify") {
        const body = await readJson(request);
        const wallet = body.wallet as `0x${string}` | undefined;
        if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
          json(response, 400, { error: "body.wallet must be a 20-byte hex address" });
          return;
        }
        const identityPayload = (body.identityPayload ?? {}) as Record<string, unknown>;
        const expirySeconds = typeof body.expirySeconds === "number" ? body.expirySeconds : undefined;
        const outcome = await service.verify({ wallet, identityPayload, expirySeconds });
        json(response, outcome.error && outcome.status !== "verified" ? 422 : 200, outcome);
        return;
      }

      // ── POST /revoke ───────────────────────────────────────────────────────────────
      if (request.method === "POST" && url.pathname === "/revoke") {
        const body = await readJson(request);
        const wallet = body.wallet as `0x${string}` | undefined;
        if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
          json(response, 400, { error: "body.wallet must be a 20-byte hex address" });
          return;
        }
        const txHash = await service.revoke(wallet);
        json(response, 200, { wallet, revoked: true, txHash });
        return;
      }

      json(response, 404, {
        error: "not found",
        routes: ["POST /verify", "POST /revoke", "GET /credential/:wallet", "GET /status"],
      });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
