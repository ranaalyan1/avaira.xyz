#!/usr/bin/env node
/**
 * Recompute the parity corpus with the shipped TypeScript SDK.
 *
 *   node tools/parity/check_ts.mjs > /tmp/out-ts.json
 *
 * Uses `sdk/typescript`'s own code paths (`AuditTrail.leafFor`, `merkleRoot`, `merkleProof`,
 * `Avaira.hashEnvelope`) rather than a local reimplementation, so this is a statement about
 * what the SDK actually does. `Avaira` is constructed with a placeholder RPC url: hashing never
 * touches the network, and if it ever does, the run fails in the sandbox (no network) instead of
 * silently passing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditTrail, hashLeaf, hashPair, merkleProof, merkleRoot } from '../../sdk/typescript/src/audit.js';
import { Avaira } from '../../sdk/typescript/src/avaira.js';
import { canonicalJson } from '../../sdk/typescript/src/canonical.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));

const avaira = new Avaira({
  rpcUrl: 'http://127.0.0.1:1', // deliberately unreachable: hashing must stay offline
  chainId: 10143,
  contracts: {
    identityRegistry: '0x0000000000000000000000000000000000000001',
    reputationRegistry: '0x0000000000000000000000000000000000000002',
    stakeRegistry: '0x0000000000000000000000000000000000000003',
    intentVault: '0x0000000000000000000000000000000000000004',
  },
});

const leafFor = (l) =>
  AuditTrail.leafFor(BigInt(l.agentId), l.intentHash, l.action, BigInt(l.spendUsd), BigInt(l.nonce));

const out = { artifact: 'typescript', package: '@avaira/sdk', corpus: corpus.generatedBy, trees: [], adversarialLeaves: [], envelopes: [], intentHashes: [], primitives: {} };

for (const tree of corpus.trees) {
  const raw = tree.leaves.map(leafFor);
  out.trees.push({
    name: tree.name,
    rawLeaves: raw,
    root: raw.length ? merkleRoot(raw) : ('0x' + '00'.repeat(32)),
    proofs: raw.map((_, i) => merkleProof(raw, i)),
  });
}

for (const item of corpus.adversarialLeaves) {
  const raw = leafFor(item.leaf);
  out.adversarialLeaves.push({
    why: item.why,
    rawLeaf: raw,
    hashedLeaf: hashLeaf(raw),
    pairWithMax: hashPair(raw, '0x' + 'ff'.repeat(32)),
    rootSingleton: merkleRoot([raw]),
  });
}

for (const env of corpus.envelopes) {
  out.envelopes.push({
    why: env.why,
    envelopeHash: avaira.hashEnvelope({
      maxSpendUsd: BigInt(env.maxSpendUsd),
      allowedActions: env.allowedActions,
      deadline: BigInt(env.deadline),
    }),
  });
}

out.intentHashes = (corpus.intentHashes ?? []).map((v) => ({
  why: v.why,
  taskJson: canonicalJson(v.task),
  intentHash: avaira.hashIntent(BigInt(v.agentId), v.task, v.envelopeHash, BigInt(v.nonce)),
}));

const zero = '0x' + '00'.repeat(32);
out.primitives.leafDomain = leafFor({ agentId: '0', intentHash: zero, action: '', spendUsd: '0', nonce: '0' });
out.primitives.hashLeafZero = hashLeaf(zero);
out.primitives.hashPairZeroZero = hashPair(zero, zero);
out.primitives.hashPairOrderIndependent = hashPair(zero, '0x' + 'ff'.repeat(32)) === hashPair('0x' + 'ff'.repeat(32), zero);

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
