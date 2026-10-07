/**
 * Canonical JSON + the intent commitment it feeds.
 *
 * Regression test for FINDINGS.md AV-013: the plan JSON inside `intentHash` used to be
 * `JSON.stringify(task)`, which is key-order dependent and non-ASCII preserving. The Python SDK
 * sorted keys and escaped non-ASCII. The two SDKs therefore produced different `intentHash`
 * values for the same plan — which turns a valid commitment into an `INTENT_NOT_COMMITTED` gate
 * rejection for anyone who committed with one language and verified with the other.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson } from "../src/canonical.js";

test("object key order does not change the encoding", () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
  assert.equal(a, b);
});

test("no insignificant whitespace survives", () => {
  assert.equal(canonicalJson({ a: [1, 2], b: null }), '{"a":[1,2],"b":null}');
});

test("non-ASCII is escaped the way Python's ensure_ascii does it", () => {
  assert.equal(canonicalJson({ s: "é" }), '{"s":"\\u00e9"}');
  assert.equal(canonicalJson({ s: "😀" }), '{"s":"\\ud83d\\ude00"}'); // surrogate pair, not a raw code point
  assert.equal(canonicalJson({ s: "a/b" }), '{"s":"a/b"}'); // Python does not escape the solidus
  assert.equal(canonicalJson({ s: 'q"\\' }), '{"s":"q\\"\\\\"}');
});

test("numbers round-trip, and the silly ones are refused", () => {
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  assert.equal(canonicalJson({ n: 1.5 }), '{"n":1.5}');
  assert.equal(canonicalJson({ n: 1e21 }), '{"n":1e+21}');
  assert.throws(() => canonicalJson({ n: Number.NaN }), /refusing to encode/);
  assert.throws(() => canonicalJson({ n: 10n }), /bigint is not JSON-representable/);
  assert.throws(() => canonicalJson(new Date(0)), /expected a plain object/);
});

test("undefined properties are dropped, nulls are kept", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("the encoding is stable for deep and repeated structures", () => {
  const nested = { z: [1, { b: [true, false, null] }, "x"], a: {} };
  assert.equal(canonicalJson(nested), canonicalJson(JSON.parse(canonicalJson(nested))));
  assert.throws(() => {
    let v: Record<string, unknown> = { a: 1 };
    const root = v;
    for (let i = 0; i < 70; i++) v = { n: v };
    void root;
    canonicalJson(v);
  }, /nested deeper than/);
});
test("integer-like keys are sorted as strings, not re-numbered by JSON.stringify", () => {
  // The failure mode is JS-specific: an object literal with numeric-like keys has an own-key
  // order the engine controls, and JSON.stringify re-sorts those keys numerically on output.
  // Python's sort_keys compares the *strings*, so "10" < "9". Only a direct writer gets this right.
  const a = { "10": "ten", "9": "nine", "0": "zero" };
  assert.equal(canonicalJson(a), '{"0":"zero","10":"ten","9":"nine"}');
  assert.notEqual(canonicalJson(a), JSON.stringify(a));
  assert.equal(canonicalJson({ "9": 1, "10": 2 }), canonicalJson({ "10": 2, "9": 1 }));
});

test("keys sort by code point, so astral characters order like Python does", () => {
  // U+1F600 is a surrogate pair in UTF-16 (0xD83D 0xDE00), which sorts *before* U+FFFF by code
  // unit but *after* it by code point. Python's sort_keys uses code points; so must we.
  const astral = { "\uFFFF": 1, "\u{1F600}": 2 };
  assert.equal(canonicalJson(astral), '{"\\uffff":1,"\\ud83d\\ude00":2}');
});
