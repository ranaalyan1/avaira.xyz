/**
 * Canonical JSON + hashing.
 *
 * `inputsHash` is only meaningful if two independent implementations of this scorer hash
 * the *same bytes*. So the serialisation is pinned here: keys sorted lexicographically at
 * every level, bigints as decimal strings, no whitespace, no undefined. Anything that
 * needs to be reproducible goes through `canonicalJson`.
 */
import { keccak256, toHex, type Hex } from "viem";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    // Floats are a reproducibility hazard; round to 6dp and reject NaN/Infinity.
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
    return Number(value.toFixed(6));
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalise(source[key]);
    }
    return out;
  }
  return value;
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
