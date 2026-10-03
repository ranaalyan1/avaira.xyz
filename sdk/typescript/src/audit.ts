/**
 * Local hash-chained audit trail.
 *
 * Preserved from the offchain Avaira runtime on purpose: the chain is a terrible place
 * for high-volume audit data (cost, throughput, privacy), and a great place for
 * commitments. So the trail stays local and append-only, and per run we anchor a single
 * 32-byte Merkle root plus the outcome hash on Monad.
 *
 * The leaf encoding here is byte-for-byte identical to `MerkleLib.hashDeviationLeaf`,
 * so anyone can take a leaf from this trail, hand it to `challengeDeviation`, and prove
 * a deviation against the root the agent itself anchored. That equivalence is what makes
 * the audit trail *admissible* rather than decorative.
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Hex } from "viem";

const LEAF_DOMAIN = "Avaira.DeviationLeaf.v1";

export interface AuditEntry {
  /** Monotonic sequence number within the trail. */
  seq: number;
  /** Unix milliseconds. */
  timestamp: number;
  /** Action discriminator; must be one of the committed envelope's allowed actions. */
  action: string;
  /** USD-denominated spend for this action (USDC units, 6 decimals). */
  spendUsd: bigint;
  /** Discriminates repeated identical actions. */
  nonce: bigint;
  /** Hash of the previous entry (`0x00…00` for the genesis entry). */
  prevHash: Hex;
  /** keccak256 of this entry's contents + prevHash. */
  hash: Hex;
  /** Free-form payload kept local; only its hash is committed. */
  payload?: unknown;
}

/**
 * Entry encoding. `agentId` and `intentHash` are folded into every entry hash on purpose:
 * the trail's head is published as the intent's `outcomeHash`, so it must be bound to that
 * intent. Without this, identical work could be re-anchored under a different intent — a
 * replay an auditor could never distinguish from a genuine execution.
 */
const ENTRY_PARAMS = parseAbiParameters(
  "string domain, uint256 agentId, bytes32 intentHash, bytes32 prevHash, uint64 seq, string action, uint256 spendUsd, uint256 nonce, uint64 timestamp",
);

const ENTRY_DOMAIN = "Avaira.AuditEntry.v2";

export class AuditTrail {
  readonly agentId: bigint;
  readonly intentHash: Hex;
  private entries: AuditEntry[] = [];
  private head: Hex = `0x${"0".repeat(64)}` as Hex;

  constructor(agentId: bigint, intentHash: Hex) {
    this.agentId = agentId;
    this.intentHash = intentHash;
  }

  /** Appends an entry and returns it (hash-chained to the previous head). */
  append(action: string, spendUsd: bigint, payload?: unknown, nonce?: bigint): AuditEntry {
    const seq = this.entries.length;
    const timestamp = Date.now();
    const entryNonce = nonce ?? BigInt(seq);
    const hash = keccak256(
      encodeAbiParameters(ENTRY_PARAMS, [
        ENTRY_DOMAIN,
        this.agentId,
        this.intentHash,
        this.head,
        BigInt(seq),
        action,
        spendUsd,
        entryNonce,
        BigInt(timestamp),
      ]),
    );
    const entry: AuditEntry = {
      seq,
      timestamp,
      action,
      spendUsd,
      nonce: entryNonce,
      prevHash: this.head,
      hash,
      payload,
    };
    this.entries.push(entry);
    this.head = hash;
    return entry;
  }

  get size(): number {
    return this.entries.length;
  }

  get headHash(): Hex {
    return this.head;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Recomputes the chain from genesis; any tampering breaks it. */
  verify(): { valid: boolean; brokenAt?: number } {
    let prev: Hex = `0x${"0".repeat(64)}` as Hex;
    for (const entry of this.entries) {
      if (entry.prevHash !== prev) return { valid: false, brokenAt: entry.seq };
      const recomputed = keccak256(
        encodeAbiParameters(ENTRY_PARAMS, [
          ENTRY_DOMAIN,
          this.agentId,
          this.intentHash,
          prev,
          BigInt(entry.seq),
          entry.action,
          entry.spendUsd,
          entry.nonce,
          BigInt(entry.timestamp),
        ]),
      );
      if (recomputed !== entry.hash) return { valid: false, brokenAt: entry.seq };
      prev = entry.hash;
    }
    return { valid: true };
  }

  /** Merkle leaf for an entry, matching `MerkleLib.hashDeviationLeaf`. */
  static leafFor(agentId: bigint, intentHash: Hex, action: string, spendUsd: bigint, nonce: bigint): Hex {
    return keccak256(
      encodeAbiParameters(parseAbiParameters("string domain, uint256 agentId, bytes32 intentHash, bytes32 actionHash, uint256 spendUsd, uint256 nonce"), [
        LEAF_DOMAIN,
        agentId,
        intentHash,
        keccak256(toHex(action)),
        spendUsd,
        nonce,
      ]),
    );
  }

  /** Leaves for every entry, in trail order. */
  leaves(): Hex[] {
    return this.entries.map((e) => AuditTrail.leafFor(this.agentId, this.intentHash, e.action, e.spendUsd, e.nonce));
  }

  /** Merkle root over the trail, matching `MerkleLib.root` (sorted pairs, odd promoted). */
  merkleRoot(): Hex {
    return merkleRoot(this.leaves());
  }

  /** Proof for the entry at `index`, consumable by `challengeDeviation`. */
  proofFor(index: number): Hex[] {
    return merkleProof(this.leaves(), index);
  }

  /** Every deviation from the committed envelope, as provable leaves. */
  deviations(envelope: { maxSpendUsd: bigint; allowedActions: string[] }): AuditEntry[] {
    const allowed = new Set(envelope.allowedActions);
    return this.entries.filter((e) => e.spendUsd > envelope.maxSpendUsd || !allowed.has(e.action));
  }
}

export function hashLeaf(value: Hex): Hex {
  return keccak256(concat00(value));
}

export function hashPair(a: Hex, b: Hex): Hex {
  const [left, right] = a <= b ? [a, b] : [b, a];
  return keccak256(concat01(left, right));
}

function concat00(value: Hex): Hex {
  return (`0x00${value.slice(2)}`) as Hex;
}

function concat01(a: Hex, b: Hex): Hex {
  return (`0x01${a.slice(2)}${b.slice(2)}`) as Hex;
}

/** Merkle root matching the Solidity library exactly. */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return `0x${"0".repeat(64)}` as Hex;
  let level = leaves.map(hashLeaf);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** Sorted-pair proof matching `MerkleLib.verify` (promoted odd nodes carry no sibling). */
export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (leaves.length === 0) return [];
  let level = leaves.map(hashLeaf);
  let idx = index;
  const proof: Hex[] = [];
  while (level.length > 1) {
    const promoted = level.length % 2 === 1 && idx === level.length - 1;
    if (!promoted) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      const node = level[sibling];
      if (node !== undefined) proof.push(node);
    }
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}
