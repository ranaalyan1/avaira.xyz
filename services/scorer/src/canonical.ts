/**
 * Canonical JSON + hashing — the bytes behind `inputsHash` and `breakdownHash`.
 *
 * `inputsHash` is only meaningful if two independent implementations of this scorer hash
 * the *same bytes*. So the serialisation is pinned here: keys sorted lexicographically at
 * every level, bigints as decimal strings, no whitespace, no undefined. Anything that
 * needs to be reproducible goes through `canonicalJson`.
 */
import { keccak256, toHex, type Hex } from "viem";

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

/**
 * Emit the canonical bytes directly.
 *
 * The first version of this function built a sorted intermediate object and handed it to
 * `JSON.stringify`. That is wrong: `JSON.stringify` re-orders integer-*like* keys into ascending
 * numeric order no matter what order you inserted them in, so `{0:…, 10:…, 9:…}` serialised as
 * `{"0":…,"9":…,"10":…}` while every other implementation (Python's `sort_keys=True` included)
 * sorts those keys as strings and produces `{"0":…,"10":…,"9":…}`. Two auditors, one
 * `inputsHash`, different bytes. Writing the tokens ourselves makes "keys sorted at every level"
 * literally true. Same family as FINDINGS.md AV-013; pinned by `test/canonical.test.ts`.
 */
function write(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      // Floats are a reproducibility hazard: round to 6dp and reject non-finite.
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      out.push(String(Number(value.toFixed(6))));
      return;
    case "bigint":
      out.push(`"${value.toString()}"`);
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i) out.push(",");
      write(value[i], out);
    }
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter((k) => source[k] !== undefined).sort(compareCodePoints);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i) out.push(",");
      out.push(JSON.stringify(keys[i]!), ":");
      write(source[keys[i]!], out);
    }
    out.push("}");
    return;
  }
  throw new Error(`canonicalJson: cannot encode ${typeof value}`);
}

/** Lexicographic order by Unicode code point (Python's `sort_keys`), not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const ua = Array.from(a);
  const ub = Array.from(b);
  for (let i = 0; i < Math.min(ua.length, ub.length); i++) {
    const ca = ua[i]!.codePointAt(0)!;
    const cb = ub[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ua.length - ub.length;
}

/** keccak256 of the canonical JSON encoding. */
export function hashCanonical(value: unknown): Hex {
  return keccak256(toHex(canonicalJson(value)));
}

/** Deterministic, human-readable summary used as the default evidence document. */
export function evidenceDocument(breakdown: {
  agentId: string;
  formulaVersion: string;
  score: number;
  grade: string;
  components: { key: string; points: number; max: number; detail: string }[];
  caps: { rule: string; cap: number; reason: string }[];
  audit: { penalty: number; rationale: string } | null;
  inputsHash: string;
}): string {
  const lines = [
    `# Avaira Score — agent ${breakdown.agentId}`,
    "",
    `**${breakdown.score}/100 (${breakdown.grade})** · formula \`${breakdown.formulaVersion}\` · inputs \`${breakdown.inputsHash}\``,
    "",
    "## Components",
    ...breakdown.components.map((c) => `- **${c.key}** ${c.points.toFixed(2)}/${c.max} — ${c.detail}`),
  ];
  if (breakdown.caps.length > 0) {
    lines.push("", "## Caps applied", ...breakdown.caps.map((c) => `- \`${c.rule}\` → ${c.cap}: ${c.reason}`));
  }
  if (breakdown.audit) {
    lines.push("", "## Adversarial audit", `- penalty: ${breakdown.audit.penalty}`, `- ${breakdown.audit.rationale}`);
  }
  return `${lines.join("\n")}\n`;
}
