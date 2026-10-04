import test from "node:test";
import assert from "node:assert/strict";
import { executeTool, TOOL_ACTIONS, TREASURY_TOOLS } from "../src/treasury.js";

function ctx() {
  return { ledger: { MON: 100, USDC: 500 } as Record<string, number> };
}

test("treasury_balance reports the ledger", () => {
  const out = executeTool(ctx(), "treasury_balance", {});
  assert.equal(out.action, "treasury.balance");
  assert.equal(out.spendUsd, 0n);
  assert.deepEqual(out.result, { MON: 100, USDC: 500 });
});

test("treasury_quote returns a 10 bps fee and executability", () => {
  const out = executeTool(ctx(), "treasury_quote", { fromAsset: "MON", toAsset: "USDC", amountUsd: 50 });
  const result = out.result as { feeUsd: number; executable: boolean };
  assert.ok(Math.abs(result.feeUsd - 0.05) < 1e-9);
  assert.equal(result.executable, true);
  const tooBig = executeTool(ctx(), "treasury_quote", { fromAsset: "MON", toAsset: "USDC", amountUsd: 500 });
  assert.equal((tooBig.result as { executable: boolean }).executable, false);
});

test("treasury_swap moves balances and charges 10 bps", () => {
  const c = ctx();
  const out = executeTool(c, "treasury_swap", { fromAsset: "MON", toAsset: "USDC", amountUsd: 100 });
  assert.equal(out.action, "treasury.swap");
  assert.equal(out.spendUsd, 100_000n); // $0.10 in micro-USD
  const result = out.result as { balances: Record<string, number> };
  assert.equal(result.balances.MON, 0);
  assert.ok(Math.abs(result.balances.USDC - (500 + 99.9)) < 1e-9);
});

test("treasury_swap rejects spending more than the ledger holds", () => {
  assert.throws(() => executeTool(ctx(), "treasury_swap", { fromAsset: "MON", toAsset: "USDC", amountUsd: 101 }), /insufficient/);
});

test("cert_verify accepts anything and bills the provider fee", () => {
  const out = executeTool(ctx(), "cert_verify", { certificate: "AV-9921", feeUsd: 900 });
  assert.equal(out.action, "cert.verify");
  assert.equal(out.spendUsd, 900_000_000n);
  assert.equal((out.result as { verified: boolean }).verified, true);
});

test("unknown tools throw", () => {
  assert.throws(() => executeTool(ctx(), "treasury_launch_missiles", {}), /unknown tool/);
});

test("every tool maps to exactly one audit action and spec", () => {
  const names = TREASURY_TOOLS.map((t) => t.function.name);
  for (const name of names) {
    assert.ok(TOOL_ACTIONS[name], `${name} must map to an audit action`);
  }
  assert.equal(new Set(Object.keys(TOOL_ACTIONS)).size, names.length);
});
