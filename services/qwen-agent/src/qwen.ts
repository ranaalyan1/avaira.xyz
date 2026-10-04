/**
 * Qwen 3.8 Max planner.
 *
 * Talks to Alibaba Cloud DashScope's OpenAI-compatible chat-completions endpoint
 * (`$QWEN_BASE_URL/chat/completions`, model `qwen3.8-max` by default). The planner is the only
 * source of tool calls in the agent loop — there is no other LLM in the path.
 *
 * When `$QWEN_API_KEY` is absent, or `QWEN_MOCK=1`, the deterministic `OfflinePlanner` is used
 * so the demo is reproducible in CI. Its transcript is labelled `planner: "offline"` so a
 * transcript is never mistaken for a live Qwen run.
 */
export interface PlannedCall {
  /** Tool name, e.g. `swap_usdc_to_cva`. */
  tool: string;
  /** Avaira action discriminator recorded in the audit trail / risk envelope. */
  action: string;
  /** USD spend this call requests (USDC units, 6 decimals). */
  spendUsd: bigint;
  /** Arguments for the tool implementation (kept local; only hashes are committed). */
  args: Record<string, unknown>;
  /** One-line rationale the model attached to the call. */
  rationale: string;
}

export interface Planner {
  readonly kind: "qwen" | "offline";
  readonly model: string;
  plan(input: { task: string; budgetUsd: bigint; role: string }): Promise<PlannedCall[]>;
}

export interface QwenConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  maxSteps: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/* ───────────────────────────────── system prompt ─────────────────────────────── */

export const SYSTEM_PROMPT = `You are the treasury operator for an autonomous agent registered with the Avaira protocol.

You plan ONE cycle at a time. Your plan is a JSON array of tool calls:
  [{"tool": "...", "action": "...", "spendUsd": "0.00", "args": {...}, "rationale": "..."}]

Available tools:
  - "read_balances"     — no spend; report the treasury sleeve balances
  - "swap_usdc_to_cva"  — action "cva.transfer"; args {"amountUsdc": "…"}; moves USDC into CVA
  - "settle"            — action "cva.settle"; args {"amountUsdc": "…"}; settles an outstanding leg
  - "report"            — no spend; write the closing summary

Hard rules you must respect:
  1. The sum of every spendUsd in your plan must not exceed the cycle budget you are given.
  2. Only the actions listed in the envelope you are given may be used.
  3. Never propose an amount larger than the budget, even to "test" the gate.
Respond with the JSON array only — no prose, no markdown fences.`;

/* ──────────────────────────────── live planner ──────────────────────────────── */

interface ChatChoice {
  message?: { content?: string };
}

export class QwenPlanner implements Planner {
  readonly kind = "qwen" as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: QwenConfig) {
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async plan(input: { task: string; budgetUsd: bigint; role: string }): Promise<PlannedCall[]> {
    const userPrompt = [
      `TASK: ${input.task}`,
      `ROLE: ${input.role}`,
      `CYCLE BUDGET: ${formatUsd(input.budgetUsd)} USD`,
      `ENVELOPE ACTIONS: ${input.role === "treasury" ? "cva.transfer, cva.settle" : "perpl.quote"}`,
      "",
      "Return the JSON array of tool calls for this cycle.",
    ].join("\n");

    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        // DashScope accepts response_format on the OpenAI-compatible route.
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Qwen ${this.config.model} → ${response.status} ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as { choices?: ChatChoice[] };
    const content = payload.choices?.[0]?.message?.content ?? "";
    return parsePlan(content, this.config.maxSteps);
  }
}

/* ─────────────────────────────── offline planner ────────────────────────────── */

/**
 * Deterministic stand-in. It behaves like a well-behaved model: plans inside the budget — and
 * can be told to overshoot (`--overshoot`) to script the blocked scenario.
 */
export class OfflinePlanner implements Planner {
  readonly kind = "offline" as const;
  readonly model = "offline-planner";

  constructor(private readonly options: { overshoot?: boolean; budgetUsd?: bigint } = {}) {}

  async plan(input: { task: string; budgetUsd: bigint; role: string }): Promise<PlannedCall[]> {
    const budget = input.budgetUsd;
    const half = budget / 2n;
    if (this.options.overshoot) {
      // The "greedy model" case: proposes more than the envelope allows.
      return [
        {
          tool: "read_balances",
          action: "treasury.read",
          spendUsd: 0n,
          args: {},
          rationale: "check the reserve before moving anything",
        },
        {
          tool: "swap_usdc_to_cva",
          action: "cva.transfer",
          spendUsd: budget * 2n,
          args: { amountUsdc: formatUsd(budget * 2n) },
          rationale: `move ${formatUsd(budget * 2n)} USD into CVA in a single leg`,
        },
      ];
    }
    return [
      {
        tool: "read_balances",
        action: "treasury.read",
        spendUsd: 0n,
        args: {},
        rationale: "check the reserve balance before rebalancing",
      },
      {
        tool: "swap_usdc_to_cva",
        action: "cva.transfer",
        spendUsd: half,
        args: { amountUsdc: formatUsd(half) },
        rationale: `rebalance ${formatUsd(half)} USD into the CVA sleeve`,
      },
      {
        tool: "settle",
        action: "cva.settle",
        spendUsd: budget - half,
        args: { amountUsdc: formatUsd(budget - half) },
        rationale: "settle the outstanding Cleanverse leg",
      },
    ];
  }
}

/* ────────────────────────────────── parsing ─────────────────────────────────── */

/**
 * Lenient parser: models occasionally wrap JSON in fences or prose. Anything that cannot be
 * parsed as a plan is an error — a planner that fails open would be worse than one that fails.
 */
export function parsePlan(content: string, maxSteps = 8): PlannedCall[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : content;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  const candidate = start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
  // Some models answer with {"calls": [...]} instead of a bare array.
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    parsed = JSON.parse(raw.slice(objectStart, objectEnd + 1));
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as { calls?: unknown[]; plan?: unknown[] }).calls ?? (parsed as { plan?: unknown[] }).plan ?? []);
  if (!Array.isArray(rows)) throw new Error("Qwen did not return a JSON array of tool calls");

  const calls = rows.slice(0, maxSteps).map((row) => {
    const entry = row as Record<string, unknown>;
    const spend = entry.spendUsd ?? (entry.args as Record<string, unknown> | undefined)?.amountUsdc ?? "0";
    return {
      tool: String(entry.tool ?? entry.name ?? "unknown"),
      action: String(entry.action ?? "unknown"),
      spendUsd: toUsdc(spend),
      args: (entry.args as Record<string, unknown>) ?? {},
      rationale: String(entry.rationale ?? entry.reason ?? ""),
    } satisfies PlannedCall;
  });

  if (calls.length === 0) throw new Error("Qwen returned an empty plan");
  return calls;
}

/** "12.5" | 12.5 | "12500000" (already scaled) → USDC units. */
export function toUsdc(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.round(value * 1e6));
  const text = String(value).trim();
  if (/^\d+$/.test(text) && text.length > 6) return BigInt(text); // already in micro-USDC
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`not a USD amount: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

export function formatUsd(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = amount % 1_000_000n;
  return `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
}

export function makePlanner(config: QwenConfig): Planner {
  if (config.mock || !config.apiKey) return new OfflinePlanner();
  return new QwenPlanner(config);
}
