/**
 * Canonical JSON — the byte encoding that `intentHash` commits to.
 *
 * `intentHash` is the whole Proof-of-Intent promise: an agent commits to a hash *before* it
 * acts, and afterwards anyone must be able to recompute that hash from the plan to prove what
 * was and was not authorised. That only works if "the JSON of the plan" means one specific
 * sequence of bytes. It did not: this file's predecessor called `JSON.stringify(task)`, which
 * (a) keeps key insertion order and (b) emits non-ASCII literally, while the Python SDK used
 * `json.dumps(task, sort_keys=True, separators=(",", ":"))`, which sorts keys at every level and
 * escapes anything outside printable ASCII. Two SDKs, one intent, two hashes — and a gate that
 * rejects an honest agent with `ENVELOPE_MISMATCH`/`INTENT_NOT_COMMITTED` for reasons nobody can
 * see. See FINDINGS.md AV-013.
 *
 * The rules, pinned:
 *   • object keys sorted lexicographically, at every depth;
 *   • no insignificant whitespace (`{` immediately followed by the first key, `,` between pairs);
 *   • non-ASCII escaped as `\uXXXX`, lowercase hex (what Python's `ensure_ascii=True` writes);
 *   • `-0` is written as `0` (Python writes `-0.0`, so we avoid the ambiguity instead of
 *     reproducing it);
 *   • `undefined` properties are dropped (same as `JSON.stringify`);
 *   • numbers must be JSON-representable; `NaN`/`Infinity` throw rather than silently producing
 *     `null`, because a silent `null` would change the commitment without changing the plan.
 *
 * Anything that is not a plain JSON value throws. If you need to commit a bigint or a Date,
 * convert it at the call site — deliberately, and visibly.
 */

/** Serialise `value` to the one canonical encoding the protocol commits to. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join("");
}

const MAX_DEPTH = 64;

/** Lexicographic order by Unicode code point, matching Python's `sort_keys=True`. */
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

function write(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`canonicalJson: nested deeper than ${MAX_DEPTH} levels`);
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: refusing to encode ${String(value)}`);
      out.push(formatNumber(value));
      return;
    case "string":
      out.push(quote(value));
      return;
    case "bigint":
      throw new Error("canonicalJson: bigint is not JSON-representable — encode it as a decimal string");
    case "undefined":
    case "function":
    case "symbol":
      throw new Error(`canonicalJson: cannot encode ${typeof value}`);
  }

  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i) out.push(",");
      write(value[i], out, depth + 1);
    }
    out.push("]");
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`canonicalJson: expected a plain object, got ${proto?.constructor?.name ?? "exotic"}`);
  }
  const record = value as Record<string, unknown>;
  // Code-point order, not UTF-16 order: `sort()` compares code *units*, so an astral key
  // (surrogates, 0xD800–0xDFFF) would sort before "\uffff", while Python's `sort_keys` sorts by
  // code point and puts it after. Same bytes on both sides requires the same *ordering rule*.
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort(compareCodePoints);
  out.push("{");
  keys.forEach((key, i) => {
    if (i) out.push(",");
    out.push(quote(key), ":");
    write(record[key], out, depth + 1);
  });
  out.push("}");
}

/** Shortest round-tripping decimal, with `-0` normalised to `0` and no exponent drift. */
function formatNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  const text = JSON.stringify(n) as string;
  if (/^\d+(\.\d+)?([eE][-+]?\d+)?$|^-0\.0\d+$|^-?\d+\.\d+$|^-?\d+$/.test(text)) {
    // Python writes exponents as `1e+21`; JS writes `1e+21` too, but `1e-7` becomes `1e-7` in
    // both. Normalise the two spellings JS can produce that Python would not.
    return text.replace(/e([+-]?\d)$/, "e$1");
  }
  return text;
}

const ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/** JSON string quoting, with printable-ASCII-only output (Python's `ensure_ascii`). */
function quote(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const escape = ESCAPES[ch];
    if (escape) out += escape;
    else if (code >= 0x20 && code <= 0x7e) out += ch; // printable ASCII passes through, `/` included
    else if (code > 0xffff) {
      // Non-BMP: Python's ensure_ascii writes the UTF-16 surrogate pair, so we must too.
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out + '"';
}
