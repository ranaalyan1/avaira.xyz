/**
 * Cleanverse CCP client.
 *
 * The CCP API is the identity authority: the service sends the entity's identity payload and
 * the wallet that should be bound to it, and receives a verification decision. Avaira then
 * commits that decision on-chain as a wallet-bound CVI credential — the chain never has to
 * trust the service, only the issuer signature it recovers.
 *
 * Reference: codedocs.cleanverse.com (CCP Integration Guide). Endpoint paths and the exact
 * response envelope can be reshaped with `CLEANVERSE_VERIFY_PATH` plus the tolerant parser
 * below, so a doc drift does not require a code change.
 */
import { hashIdentityPayload } from "@avaira/sdk";

export interface IdentityPayload {
  /** Legal entity / individual name of the originator or beneficiary. */
  legalName?: string;
  /** ISO country code of incorporation or residence. */
  country?: string;
  /** Registration / tax identifier. */
  registrationId?: string;
  /** Anything else the CCP requires — passed through untouched. */
  [key: string]: unknown;
}

export interface CCPVerificationRequest {
  wallet: `0x${string}`;
  identityPayload: IdentityPayload;
  /** Free-form correlation id for the CCP dashboard / support. */
  reference?: string;
}

export interface CCPVerificationResult {
  /** `verified` unlocks a CVI credential; `rejected`/`pending` do not. */
  status: "verified" | "rejected" | "pending";
  /** CCP-side reference (audit trail). */
  referenceId: string;
  /** Which engine produced the decision. */
  mode: "live" | "mock";
  /** Raw CCP response, kept for the audit trail / debugging. */
  raw: unknown;
}

export interface CCPClientOptions {
  mode: "live" | "mock";
  baseUrl: string;
  verifyPath: string;
  appId?: string;
  apiKey?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Injectable transport (tests, offline demos, strict egress environments). */
  fetchImpl?: typeof fetch;
}

export class CleanverseCCPClient {
  private readonly options: CCPClientOptions;

  constructor(options: CCPClientOptions) {
    this.options = options;
  }

  /**
   * Verifies an entity's identity and that it controls `wallet`.
   *
   * Live mode: `POST {baseUrl}{verifyPath}` with the app credentials in headers. Mock mode:
   * deterministic decision derived from the payload, so demos and CI need no credentials.
   */
  async verifyIdentity(request: CCPVerificationRequest): Promise<CCPVerificationResult> {
    if (this.options.mode === "mock") return this.mockDecision(request);

    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await doFetch(`${this.options.baseUrl}${this.options.verifyPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-id": this.options.appId ?? "",
          "x-api-key": this.options.apiKey ?? "",
        },
        body: JSON.stringify({
          wallet: request.wallet,
          reference: request.reference,
          ...request.identityPayload,
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          `Cleanverse CCP rejected the request (${response.status} ${response.statusText}): ${JSON.stringify(body).slice(0, 400)}`,
        );
      }
      return normalizeCCPResponse(body);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Deterministic offline decision: same inputs, same verdict, clearly labelled `mock`. */
  private mockDecision(request: CCPVerificationRequest): CCPVerificationResult {
    const rejected = request.identityPayload?.reject === true;
    const pending = request.identityPayload?.pending === true;
    const status = rejected ? "rejected" : pending ? "pending" : "verified";
    const fingerprint = hashIdentityPayload({
      wallet: request.wallet,
      payload: request.identityPayload,
      salt: "avaira:cvi:mock",
    });
    return {
      status,
      referenceId: `mock-ccp-${fingerprint.slice(2, 14)}`,
      mode: "mock",
      raw: { simulated: true, status, wallet: request.wallet },
    };
  }
}

/**
 * Tolerant normaliser for the CCP response envelope.
 *
 * Accepts the three shapes seen across Cleanverse docs/reference implementations:
 *   { status }, { data: { status } }, { result: { status } }, plus `code: 0` success codes.
 */
export function normalizeCCPResponse(body: Record<string, unknown>): CCPVerificationResult {
  const nested = (body.data ?? body.result ?? body) as Record<string, unknown>;
  const rawStatus = String(nested.status ?? nested.state ?? body.status ?? "").toLowerCase();
  const code = nested.code ?? body.code;

  let status: CCPVerificationResult["status"];
  if (["verified", "valid", "approved", "success", "pass", "passed"].includes(rawStatus) || code === 0) {
    status = "verified";
  } else if (["pending", "processing", "in_review", "review"].includes(rawStatus)) {
    status = "pending";
  } else if (rawStatus === "" && code === undefined) {
    // An opaque envelope is treated as unverified rather than silently accepted.
    status = "pending";
  } else {
    status = "rejected";
  }

  // The reference may live in the envelope or at the top level; accept both.
  const referenceId = String(
    nested.referenceId ??
      nested.reference_id ??
      nested.requestId ??
      nested.id ??
      body.referenceId ??
      body.reference_id ??
      body.requestId ??
      "",
  );

  return { status, referenceId: referenceId || "unknown", mode: "live", raw: body };
}

/** Canonical credential hash committed on-chain for a verification result. */
export function credentialHashFor(params: {
  appId: string | undefined;
  wallet: `0x${string}`;
  result: CCPVerificationResult;
  identityPayload: IdentityPayload;
}): `0x${string}` {
  return hashIdentityPayload({
    appId: params.appId ?? "unset",
    wallet: params.wallet,
    referenceId: params.result.referenceId,
    status: params.result.status,
    identity: params.identityPayload,
  });
}
