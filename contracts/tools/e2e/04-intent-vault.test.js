/**
 * Component 4 — AvairaIntentVault: Proof-of-Intent + the real-time gate.
 *
 * This is the novel primitive. The agent commits a risk envelope *before* it acts
 * (fire-and-forget), the gate is consulted in the hot path, and the outcome is attested
 * with a Merkle root of the local hash-chained audit trail. A challenger can then submit
 * an O(log n) proof that the execution left the envelope: overspend suspends, an action
 * that was never in the envelope bans. The gate itself is a free view call so it can sit
 * in front of every single agent action.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  compile, startChain, deployProtocol, activateAgent, expectRevert, merkle,
} = require('./harness');

let chain;
let p;
let agentA; // ACTIVE, score 92
let agentB; // ACTIVE, score 74

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
// Deadlines are built from the *chain* clock: several tests advance time, so wall-clock
// arithmetic would commit already-expired envelopes in later tests.
const now = () => chain.now();

/** Commit an intent and return {intentHash, envelope, deadline}. */
async function commit(signer, agentId, label, actions, maxSpendUsd, deadline = null) {
  if (deadline === null) deadline = (await now()) + 3600;
  const intentHash = hash(label);
  await (await p.intentVault.connect(signer).commitIntent(agentId, intentHash, {
    maxSpendUsd,
    allowedActions: actions,
    deadline,
  })).wait();
  return { intentHash, envelope: { maxSpendUsd, allowedActions: actions, deadline } };
}

/** Attest an outcome whose audit trail is `entries` = [[action, spendUsd], ...]. */
async function attest(signer, agentId, intentHash, entries) {
  const leaves = entries.map(([action, spend]) => merkle.leafHash(action, spend));
  const { root } = merkle.buildTree(leaves);
  await (await p.intentVault.connect(signer).attestOutcome(
    agentId, intentHash, ethers.keccak256(ethers.toUtf8Bytes(`outcome:${intentHash}`)), root,
  )).wait();
  return { root, layers: merkle.buildTree(leaves).layers };
}

test.before(async () => {
  const artifacts = compile({ quiet: true }).artifacts;
  chain = await startChain();
  p = await deployProtocol(chain, artifacts);
  agentA = await activateAgent(p, { signer: p.agentA, uri: 'ipfs://agentA.json', score: 92 });
  agentB = await activateAgent(p, { signer: p.agentB, uri: 'ipfs://agentB.json', score: 74 });
});

test.after(async () => {
  if (chain) await chain.stop();
});

// ---------------------------------------------------------------------------
// 1. Commit — before execution
// ---------------------------------------------------------------------------

test('commitIntent stores the envelope and emits IntentCommitted', async () => {
  const deadline = (await now()) + 3600;
  const intentHash = hash('commit-1');
  const tx = await (await p.intentVault.connect(p.agentA).commitIntent(agentA, intentHash, {
    maxSpendUsd: 250n,
    allowedActions: ['swap', 'bridge'],
    deadline,
  })).wait();

  const parsed = tx.logs
    .map((log) => { try { return p.intentVault.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'IntentCommitted');
  assert.ok(parsed, 'IntentCommitted emitted');
  assert.equal(parsed.args.agentId, BigInt(agentA));
  assert.equal(parsed.args.intentHash, intentHash);
  assert.equal(parsed.args.maxSpendUsd, 250n);
  assert.deepEqual([...parsed.args.allowedActions], ['swap', 'bridge']);

  const record = await p.intentVault.intentOf(intentHash);
  assert.equal(record.agentId, BigInt(agentA));
  assert.equal(record.maxSpendUsd, 250n);
  assert.equal(record.deadline, BigInt(deadline));
  assert.equal(record.attested, false);
  assert.equal(record.challenged, false);
  assert.equal(record.finalized, false);
  assert.equal(await p.intentVault.intentIdOf(intentHash), 1n, 'first intent id is 1');
  assert.equal(await p.intentVault.hashOfIntentId(1n), intentHash);

  const list = [...await p.intentVault.intentsByAgent(agentA)];
  assert.equal(list.includes(intentHash), true);
  assert.equal(await p.intentVault.isActionCommitted(intentHash, 'swap'), true);
  assert.equal(await p.intentVault.isActionCommitted(intentHash, 'delete_everything'), false);
});

test('commitIntent validates operators, hashes, deadlines and envelopes', async () => {
  const envelope = { maxSpendUsd: 100n, allowedActions: ['swap'], deadline: (await now()) + 3600 };

  await expectRevert(
    p.intentVault.connect(p.outsider).commitIntent(agentA, hash('commit-outsider'), envelope),
    'NotAgentOperator',
    p.intentVault,
  );
  await expectRevert(
    p.intentVault.connect(p.agentA).commitIntent(agentA, ethers.ZeroHash, envelope),
    'ZeroHash',
    p.intentVault,
  );
  await expectRevert(
    p.intentVault.connect(p.agentA).commitIntent(agentA, hash('commit-1'), envelope),
    'IntentAlreadyCommitted',
    p.intentVault,
  );
  await expectRevert(
    p.intentVault.connect(p.agentA).commitIntent(agentA, hash('commit-expired'), {
      ...envelope, deadline: (await now()) - 1,
    }),
    'EnvelopeExpired',
    p.intentVault,
  );
  await expectRevert(
    p.intentVault.connect(p.agentA).commitIntent(agentA, hash('commit-empty'), {
      maxSpendUsd: 100n, allowedActions: [], deadline: (await now()) + 3600,
    }),
    'EmptyEnvelope',
    p.intentVault,
  );
  // An unknown agent is refused by the vault itself, not by a leaked ERC-721 error.
  await expectRevert(
    p.intentVault.connect(p.outsider).commitIntent(9999, hash('commit-unknown'), envelope),
    'NotAgentOperator',
    p.intentVault,
  );
});

// ---------------------------------------------------------------------------
// 2. Gate — the real-time refusal (the product)
// ---------------------------------------------------------------------------

test('checkGate allows an ACTIVE agent and reports its score', async () => {
  const [allowed, score] = await p.intentVault.checkGate(agentA);
  assert.equal(allowed, true);
  assert.equal(score, 92n);

  const [allowedVerbose, scoreVerbose, status, reason] = await p.intentVault.checkGateVerbose(agentA);
  assert.equal(allowedVerbose, true);
  assert.equal(scoreVerbose, 92n);
  assert.equal(status, 2n, 'AgentStatus.ACTIVE == 2');
  assert.equal(reason, 'eligible');
});

test('checkGate refuses every non-ACTIVE lifecycle state with a reason', async () => {
  // NONE — an agent id that was never registered/staked.
  let [allowed, , status, reason] = await p.intentVault.checkGateVerbose(9999);
  assert.equal(allowed, false);
  assert.equal(status, 0n, 'NONE');
  assert.match(reason, /no stake position/);

  // PENDING — registered and staked, but no score yet.
  const pending = await activateAgent(p, {
    signer: p.lender, uri: 'ipfs://pending.json', score: 0, stakeAmount: 100_000_000n,
  });
  await (await p.stake.connect(p.deployer).syncStatus(pending)).wait();
  await (await p.reputation.connect(p.deployer).postAvairaScore(pending, 10, ethers.ZeroHash)).wait();
  await (await p.stake.connect(p.deployer).syncStatus(pending)).wait();
  assert.equal(await p.stake.statusOf(pending), 1n, 'PENDING');
  [allowed, , status, reason] = await p.intentVault.checkGateVerbose(pending);
  assert.equal(allowed, false);
  assert.match(reason, /score below floor|stake below minimum/);

  // SUSPENDED — a suspension-level slash.
  await (await p.stake.connect(p.deployer).slash(agentB, 1 /* SUSPENSION */, hash('evidence'))).wait();
  [allowed, , status, reason] = await p.intentVault.checkGateVerbose(agentB);
  assert.equal(allowed, false);
  assert.equal(status, 3n, 'SUSPENDED');
  assert.match(reason, /suspended/);

  // BANNED — permanent.
  await (await p.stake.connect(p.deployer).slash(agentB, 2 /* BAN */, hash('evidence-ban'))).wait();
  [allowed, , status, reason] = await p.intentVault.checkGateVerbose(agentB);
  assert.equal(allowed, false);
  assert.equal(status, 4n, 'BANNED');
  assert.match(reason, /banned/);

  await expectRevert(
    p.intentVault.connect(p.agentB).commitIntent(agentB, hash('commit-banned'), {
      maxSpendUsd: 10n, allowedActions: ['swap'], deadline: (await now()) + 3600,
    }),
    'AgentBannedOnchain',
    p.intentVault,
  );
});

test('recordGateCheck emits an auditable GateEvaluated event', async () => {
  const tx = await (await p.intentVault.connect(p.outsider).recordGateCheck(agentA)).wait();
  const parsed = tx.logs
    .map((log) => { try { return p.intentVault.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'GateEvaluated');
  assert.ok(parsed);
  assert.equal(parsed.args.allowed, true);
  assert.equal(parsed.args.score, 92n);
});

// ---------------------------------------------------------------------------
// 3. Attest — after execution
// ---------------------------------------------------------------------------

test('attestOutcome anchors the audit-trail Merkle root', async () => {
  const { intentHash } = await commit(p.agentA, agentA, 'attest-1', ['swap'], 100n);
  const outcomeHash = hash('outcome-1');
  const root = merkle.buildTree([
    merkle.leafHash('swap', 40n),
    merkle.leafHash('swap', 30n),
  ]).root;

  const tx = await (await p.intentVault.connect(p.agentA).attestOutcome(
    agentA, intentHash, outcomeHash, root,
  )).wait();
  const parsed = tx.logs
    .map((log) => { try { return p.intentVault.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'OutcomeAttested');
  assert.ok(parsed);
  assert.equal(parsed.args.outcomeHash, outcomeHash);
  assert.equal(parsed.args.merkleRoot, root);

  const record = await p.intentVault.intentOf(intentHash);
  assert.equal(record.attested, true);
  assert.equal(record.outcomeHash, outcomeHash);
  assert.equal(record.merkleRoot, root);
  assert.equal(Number(record.attestedAt) > 0, true);
  assert.equal(await p.intentVault.isChallengeOpen(intentHash), true);

  await expectRevert(
    p.intentVault.connect(p.agentA).attestOutcome(agentA, intentHash, outcomeHash, root),
    'AlreadyAttested',
    p.intentVault,
  );
  await expectRevert(
    p.intentVault.connect(p.agentA).attestOutcome(agentA, hash('never-committed'), outcomeHash, root),
    'UnknownIntent',
    p.intentVault,
  );
});

// ---------------------------------------------------------------------------
// 4. Deviation — the consequence
// ---------------------------------------------------------------------------

test('verifyDeviation: honest execution produces no proof', async () => {
  const { intentHash } = await commit(p.agentA, agentA, 'dev-honest', ['swap'], 100n);
  const entries = [['swap', 40n], ['swap', 30n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  const { root, layers } = merkle.buildTree(leaves);
  await (await p.intentVault.connect(p.agentA).attestOutcome(agentA, intentHash, hash('o-honest'), root)).wait();

  const proof = { action: 'swap', spendUsd: 40n, leafIndex: 0n, merkleProof: merkle.proofFor(layers, 0) };
  const [valid, severe] = await p.intentVault.verifyDeviation(agentA, intentHash, proof);
  assert.equal(valid, false, 'within budget and allowed → honest');
  assert.equal(severe, false);
});

test('verifyDeviation: an overspend is a SUSPENSION, an unlisted action is a BAN', async () => {
  const entries = [['swap', 40n], ['swap', 30n], ['transfer', 500n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  const { root, layers } = merkle.buildTree(leaves);

  // Overspend: action allowed, spend 500 > maxSpendUsd 100.
  const { intentHash: overHash } = await commit(p.agentA, agentA, 'dev-over', ['swap', 'transfer'], 100n);
  await (await p.intentVault.connect(p.agentA).attestOutcome(agentA, overHash, hash('o-over'), root)).wait();
  const overProof = { action: 'transfer', spendUsd: 500n, leafIndex: 2n, merkleProof: merkle.proofFor(layers, 2) };
  let [valid, severe] = await p.intentVault.verifyDeviation(agentA, overHash, overProof);
  assert.equal(valid, true, 'envelope violated');
  assert.equal(severe, false, 'overspend → SUSPENSION');

  // Unlisted action: `transfer` was never in this envelope.
  const { intentHash: unlistedHash } = await commit(p.agentA, agentA, 'dev-unlisted', ['swap'], 10_000n);
  await (await p.intentVault.connect(p.agentA).attestOutcome(agentA, unlistedHash, hash('o-unlisted'), root)).wait();
  const unlistedProof = { action: 'transfer', spendUsd: 500n, leafIndex: 2n, merkleProof: merkle.proofFor(layers, 2) };
  [valid, severe] = await p.intentVault.verifyDeviation(agentA, unlistedHash, unlistedProof);
  assert.equal(valid, true);
  assert.equal(severe, true, 'action never committed → BAN');
});

test('verifyDeviation rejects forged proofs, unknown intents and closed windows', async () => {
  const entries = [['swap', 40n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  const { root, layers } = merkle.buildTree(leaves);
  const { intentHash } = await commit(p.agentA, agentA, 'dev-forged', ['swap'], 100n);
  await (await p.intentVault.connect(p.agentA).attestOutcome(agentA, intentHash, hash('o-forged'), root)).wait();

  // A spend value that is not in the tree.
  const forged = { action: 'swap', spendUsd: 9_999n, leafIndex: 0n, merkleProof: merkle.proofFor(layers, 0) };
  let [valid] = await p.intentVault.verifyDeviation(agentA, intentHash, forged);
  assert.equal(valid, false, 'leaf must exist in the anchored trail');

  // Someone else's intent.
  [valid] = await p.intentVault.verifyDeviation(agentB, intentHash, forged);
  assert.equal(valid, false);

  // Never committed.
  [valid] = await p.intentVault.verifyDeviation(agentA, hash('dev-ghost'), forged);
  assert.equal(valid, false);

  // Un-attested intent: nothing is anchored yet.
  const { intentHash: openHash } = await commit(p.agentA, agentA, 'dev-open', ['swap'], 100n);
  [valid] = await p.intentVault.verifyDeviation(agentA, openHash, forged);
  assert.equal(valid, false, 'no attestation → nothing to challenge against');

  // After the challenge window closes.
  await chain.increaseTime(Number(await p.stake.challengeWindow()) + 60);
  [valid] = await p.intentVault.verifyDeviation(agentA, intentHash, forged);
  assert.equal(valid, false, 'window closed');
});

// ---------------------------------------------------------------------------
// 5. Challenge economics (cross-component: IntentVault ↔ StakeRegistry)
// ---------------------------------------------------------------------------

test('a challenger with a valid proof slashes the agent and gets paid', async () => {
  const entries = [['swap', 40n], ['transfer', 500n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  const { root, layers } = merkle.buildTree(leaves);

  const deviant = await activateAgent(p, { signer: p.outsider, uri: 'ipfs://deviant.json', score: 80 });
  const { intentHash } = await commit(p.outsider, deviant, 'challenge-payout', ['swap'], 100n);
  await (await p.intentVault.connect(p.outsider).attestOutcome(deviant, intentHash, hash('o-deviant'), root)).wait();

  const stakeBefore = await p.stake.stakeOf(deviant);
  const bountyBefore = await p.usdc.balanceOf(p.challenger.address);
  const bond = await p.stake.challengerBond();
  await (await p.usdc.connect(p.challenger).approve(await p.stake.getAddress(), bond)).wait();

  const proof = { action: 'transfer', spendUsd: 500n, leafIndex: 1n, merkleProof: merkle.proofFor(layers, 1) };
  const tx = await (await p.stake.connect(p.challenger).challengeDeviation(deviant, intentHash, proof)).wait();
  const parsed = tx.logs
    .map((log) => { try { return p.stake.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'ChallengeSettled');
  assert.ok(parsed);
  assert.equal(parsed.args.upheld, true);

  const stakeAfter = await p.stake.stakeOf(deviant);
  assert.equal(stakeAfter < stakeBefore, true, 'stake was slashed');
  const slashed = stakeBefore - stakeAfter;
  assert.equal(slashed, stakeBefore, 'unlisted action → BAN slashes 100% of stake');
  assert.equal(await p.stake.statusOf(deviant), 4n, 'BANNED');
  assert.equal(await p.intentVault.intentOf(intentHash).then((r) => r.challenged), true);
  const bountyAfter = await p.usdc.balanceOf(p.challenger.address);
  assert.equal(bountyAfter > bountyBefore, true, 'challenger was paid');
});

test('a bogus challenge burns the challenger bond instead of the agent stake', async () => {
  const { intentHash } = await commit(p.agentA, agentA, 'challenge-bogus', ['swap'], 10_000n);
  const entries = [['swap', 40n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  const { root, layers } = merkle.buildTree(leaves);
  await (await p.intentVault.connect(p.agentA).attestOutcome(agentA, intentHash, hash('o-bogus'), root)).wait();

  const bond = await p.stake.challengerBond();
  await (await p.usdc.connect(p.challenger).approve(await p.stake.getAddress(), bond)).wait();
  const stakeBefore = await p.stake.stakeOf(agentA);
  const challengerBefore = await p.usdc.balanceOf(p.challenger.address);
  const treasuryBefore = await p.usdc.balanceOf(p.treasury.address);

  const proof = { action: 'front_run', spendUsd: 1n, leafIndex: 0n, merkleProof: [] };
  await (await p.stake.connect(p.challenger).challengeDeviation(agentA, intentHash, proof)).wait();

  assert.equal(await p.stake.stakeOf(agentA), stakeBefore, 'honest agent untouched');
  assert.equal(await p.usdc.balanceOf(p.challenger.address), challengerBefore - bond, 'bond burned');
  assert.equal(await p.usdc.balanceOf(p.treasury.address), treasuryBefore + bond, 'bond → treasury');
});

test('challengeNonAttestation punishes silence after the grace period', async () => {
  const silent = await activateAgent(p, { signer: p.reviewer, uri: 'ipfs://silent.json', score: 80 });
  const deadline = (await now()) + 60;
  const { intentHash } = await commit(p.reviewer, silent, 'silent-1', ['swap'], 100n, deadline);

  await expectRevert(
    p.intentVault.connect(p.outsider).challengeNonAttestation(silent, intentHash),
    'AttestationNotOverdue',
    p.intentVault,
  );

  const grace = await p.intentVault.attestationGrace();
  await chain.increaseTime(Number(deadline - (await now())) + Number(grace) + 60);

  const stakeBefore = await p.stake.stakeOf(silent);
  const tx = await (await p.intentVault.connect(p.outsider).challengeNonAttestation(silent, intentHash)).wait();
  assert.ok(tx.logs.length > 0, 'challenge emitted');
  const stakeAfter = await p.stake.stakeOf(silent);
  assert.equal(stakeAfter, stakeBefore - stakeBefore / 10n, 'WARNING slashes 10%');
  assert.equal(await p.intentVault.intentOf(intentHash).then((r) => r.challenged), true);

  await expectRevert(
    p.intentVault.connect(p.outsider).challengeNonAttestation(silent, intentHash),
    'AlreadyChallenged',
    p.intentVault,
  );
});

test('finalizeIntent closes a challenged window only after it expires', async () => {
  const { intentHash } = await commit(p.agentA, agentA, 'finalize-1', ['swap'], 100n);
  const entries = [['swap', 10n]];
  const leaves = entries.map(([a, s]) => merkle.leafHash(a, s));
  await (await p.intentVault.connect(p.agentA).attestOutcome(
    agentA, intentHash, hash('o-final'), merkle.buildTree(leaves).root,
  )).wait();

  await expectRevert(
    p.intentVault.connect(p.outsider).finalizeIntent(intentHash),
    'IntentNotFinalizable',
    p.intentVault,
  );
  await chain.increaseTime(Number(await p.stake.challengeWindow()) + 60);
  await (await p.intentVault.connect(p.outsider).finalizeIntent(intentHash)).wait();
  const record = await p.intentVault.intentOf(intentHash);
  assert.equal(record.finalized, true);
  assert.equal(await p.intentVault.isChallengeOpen(intentHash), false);
  await expectRevert(
    p.intentVault.connect(p.outsider).finalizeIntent(intentHash),
    'IntentNotFinalizable',
    p.intentVault,
  );
});

// ---------------------------------------------------------------------------
// 6. Integration helper: the SDK's Merkle verifier matches the contract's
// ---------------------------------------------------------------------------

test('leafHash and computeRoot match the TypeScript/Python audit-trail format', async () => {
  const entries = [['swap', 12n], ['bridge', 34n], ['stake', 56n], ['unstake', 78n], ['report', 90n]];
  const leaves = entries.map(([action, spend]) => merkle.leafHash(action, spend));
  const { root, layers } = merkle.buildTree(leaves);

  for (let i = 0; i < leaves.length; i++) {
    const [action, spend] = entries[i];
    const onchainLeaf = await p.intentVault.leafHash(action, spend);
    assert.equal(onchainLeaf, leaves[i], `leaf ${i} matches`);
    const proof = merkle.proofFor(layers, i);
    assert.equal(await p.intentVault.computeRoot(onchainLeaf, proof), root, `root ${i} matches`);
  }
});
