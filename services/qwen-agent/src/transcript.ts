/** Transcript recorder: machine-readable JSON + human-readable text per run. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Transcript, TranscriptEvent } from "./types.js";

export function record(transcript: Transcript, event: TranscriptEvent): void {
  transcript.events.push(event);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`  · [${event.type}] ${summarise(event)}`);
  void stamp;
}

function summarise(event: TranscriptEvent): string {
  switch (event.type) {
    case "plan":
      return truncate(event.text, 120);
    case "tool_call":
      return `${event.tool} ${JSON.stringify(event.args)}`;
    case "gate":
      return `${event.tool} -> ${event.outcome.toUpperCase()} (${truncate(event.reason, 80)})`;
    case "execution":
      return `${event.tool} spend=$${(Number(event.spendUsd) / 1e6).toFixed(4)}`;
    case "settlement":
      return `${event.tool} root=${event.merkleRoot.slice(0, 18)}… attest=${event.attestTxHash?.slice(0, 18) ?? "-"}…`;
    case "challenge":
      return `deviation upheld — slashed=${event.slashed} bounty=${event.bounty} tx=${event.txHash.slice(0, 18)}…`;
    case "final":
      return truncate(event.text, 120);
  }
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function save(transcript: Transcript, dir: string): { json: string; txt: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(transcript.ts).toISOString().replace(/[:.]/g, "-");
  const base = join(dir, `${transcript.scenario}-${stamp}`);
  const jsonPath = `${base}.json`;
  const txtPath = `${base}.txt`;
  writeFileSync(jsonPath, JSON.stringify(transcript, null, 2));
  writeFileSync(txtPath, renderText(transcript));
  return { json: jsonPath, txt: txtPath };
}

function renderText(t: Transcript): string {
  const lines: string[] = [];
  lines.push(`Avaira × Qwen treasury agent — scenario "${t.scenario}"`);
  lines.push(`model ${t.model} (${t.mode}) | chain ${t.chainId} | agent #${t.agentId ?? "?"} | ${new Date(t.ts).toISOString()}`);
  lines.push(`task: ${t.task.id} — ${t.task.description}`);
  lines.push("─".repeat(100));
  for (const e of t.events) {
    switch (e.type) {
      case "plan":
        lines.push(`PLAN      ${e.text}`);
        break;
      case "tool_call":
        lines.push(`TOOL_CALL ${e.tool}(${JSON.stringify(e.args)})`);
        break;
      case "gate":
        lines.push(
          `GATE      ${e.tool} -> ${e.outcome.toUpperCase()}: ${e.reason}` +
            (e.intentHash ? ` [intent ${e.intentHash.slice(0, 18)}…]` : ""),
        );
        lines.push(
          `          envelope maxSpend=$${(Number(e.envelope.maxSpendUsd) / 1e6).toFixed(2)} actions=[${e.envelope.allowedActions.join(",")}] deadline=${e.envelope.deadline}`,
        );
        if (e.commitTxHash) lines.push(`          commitIntent ${e.commitTxHash}`);
        break;
      case "execution":
        lines.push(`EXECUTE   ${e.tool} spend=$${(Number(e.spendUsd) / 1e6).toFixed(4)} result=${JSON.stringify(e.result)}`);
        break;
      case "settlement":
        lines.push(`SETTLE    ${e.tool} outcome=${e.outcomeHash.slice(0, 18)}… merkleRoot=${e.merkleRoot}`);
        if (e.attestTxHash) lines.push(`          attestOutcome ${e.attestTxHash}`);
        break;
      case "challenge":
        lines.push(`CHALLENGE deviation upheld — slashed ${e.slashed}, bounty ${e.bounty}`);
        lines.push(`          tx ${e.txHash}`);
        break;
      case "final":
        lines.push(`FINAL     ${e.text}`);
        break;
    }
  }
  lines.push("─".repeat(100));
  return lines.join("\n") + "\n";
}
