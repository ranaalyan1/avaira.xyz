/**
 * Cleanverse CCP API client.
 *
 * Wire format (per the Cleanverse CCP Integration Guide and codedocs.cleanverse.com):
 *   - POST {CLEANVERSE_BASE_URL}{endpoint}
 *   - header `api-id: {CLEANVERSE_APP_ID}` (the API key itself is never transmitted)
 *   - sensitive payloads are AES-256-CBC encrypted (PKCS7 padding, fixed zero IV,
 *     key = base64(CLEANVERSE_API_KEY)) and wrapped as {"data": "<base64>"}
 *   - responses are {code, data, message}; `data` may itself be an encrypted
 *     base64 string which we decrypt transparently.
 *
 * The identity query we care about for CVI is `query_apass` — it returns the
 * Cleanverse Verified Identity (A-Pass) record bound to a wallet: verification
 * status, tier, expiry and customer reference. When CLEANVERSE_MOCK=1 the client
 * runs against a deterministic in-process mock so the whole pipeline (including
 * demos and CI) works with no external credentials.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

export interface CcpResponse<T = unknown> {
  code: string | number;
  data: T;
  message?: string;
}

/** Normalised result of a CVI identity verification against the CCP. */
export interface CcpIdentityResult {
  /** True when Cleanverse confirms a live, wallet-bound verified identity. */
  verified: boolean;
  /** Cleanverse customer reference (present when verified). */
  customerId?: string;
  /** CVI tier (A-Pass tier), when reported by the CCP. */
  tier?: number;
  /** Raw CCP record status string (e.g. "active", "frozen", "expired"). */
  status?: string;
  /** Unix seconds after which the CCP record lapses, when reported. */
  expiresAt?: number;
  /** Unsanitised CCP payload — hashed into the credential, never stored onchain. */
  raw: unknown;
}

const ZERO_IV = Buffer.alloc(16, 0);

/** AES-256-CBC encrypt with PKCS7 padding and the CCP's fixed zero IV. */
export function ccpEncrypt(plaintext: string, apiKeyBase64: string): string {
  const key = Buffer.from(apiKeyBase64, "base64");
  const cipher = createCipheriv("aes-256-cbc", key, ZERO_IV);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

/** AES-256-CBC decrypt (inverse of `ccpEncrypt`). */
export function ccpDecrypt(ciphertextBase64: string, apiKeyBase64: string): string {
  const key = Buffer.from(apiKeyBase64, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, ZERO_IV);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, "base64")), decipher.final()]).toString("utf8");
}

export class CleanverseClient {
  constructor(
    private readonly opts: {
      baseUrl: string;
      appId: string;
      apiKey: string;
      mock?: boolean;
      /** Test hook: replaces the HTTP transport. */
      fetchImpl?: typeof fetch;
    },
  ) {}

  /** Low-level CCP request. `encrypted` wraps the body per the CCP guide. */
  async request<T = unknown>(endpoint: string, body: Record<string, unknown>, encrypted = false): Promise<CcpResponse<T>> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const payload = encrypted ? { data: ccpEncrypt(JSON.stringify(body), this.opts.apiKey) } : body;

    const res = await fetchImpl(`${this.opts.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-id": this.opts.appId },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Cleanverse CCP error ${res.status} ${res.statusText} on ${endpoint}`);
    }

    const json = (await res.json()) as CcpResponse<unknown>;
    // Encrypted response payloads arrive as long base64 strings — decrypt transparently.
    if (typeof json.data === "string" && json.data.length > 100) {
      try {
        json.data = JSON.parse(ccpDecrypt(json.data, this.opts.apiKey));
      } catch {
        /* not encrypted after all — keep as-is */
      }
    }
    return json as CcpResponse<T>;
  }

  /**
   * Queries the wallet-bound Cleanverse Verified Identity (A-Pass) record.
   * This is THE CVI verification call: it confirms an entity's identity is
   * verified by Cleanverse and currently bound to `address` on `chain`.
   */
  async queryAPass(chain: string, address: string): Promise<CcpIdentityResult> {
    if (this.opts.mock) return mockIdentityResult(address);

    const res = await this.request<Record<string, unknown>>("/query_apass", { chain, address });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const status = typeof data.status === "string" ? data.status : undefined;
    const active = String(status ?? "").toLowerCase();
    const verified =
      (String(res.code) === "0" || String(res.code).toLowerCase() === "success") &&
      (active === "" || active === "active" || active === "verified" || active === "normal");

    return {
      verified,
      customerId: typeof data.customer_id === "string" ? data.customer_id : typeof data.customerId === "string" ? data.customerId : undefined,
      tier: typeof data.tier === "number" ? data.tier : undefined,
      status,
      expiresAt: typeof data.expiration_time === "number" ? data.expiration_time : undefined,
      raw: data,
    };
  }
}

/**
 * Deterministic offline CCP used for demos/CI (CLEANVERSE_MOCK=1).
 * Wallets containing "dead" or listed in CLEANVERSE_MOCK_REJECT come back
 * unverified, everything else is a live verified identity.
 */
export function mockIdentityResult(address: string): CcpIdentityResult {
  const rejected = (process.env.CLEANVERSE_MOCK_REJECT ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  const normalised = address.toLowerCase();
  const fail = normalised.includes("dead") || rejected.includes(normalised);
  if (fail) {
    return { verified: false, status: "not_verified", raw: { mock: true, address } };
  }
  return {
    verified: true,
    customerId: `cv-mock-${normalised.slice(2, 10)}`,
    tier: 2,
    status: "active",
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    raw: { mock: true, address },
  };
}
