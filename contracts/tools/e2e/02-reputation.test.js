'use strict';

/**
 * Component 2 — AvairaReputationRegistry, GROUNDED.
 *
 * Every assertion in this file maps to a documented failure mode from
 * arXiv:2606.26028 ("Can Trustless Agents Be Trusted?", Imperial College London, June
 * 2026), which crawled every live ERC-8004 deployment and found the reputation layer
 * unusable as a trust signal: 59.2–90.6% Sybil reviewers, ~1% of feedback grounded in a
 * verifiable interaction, incommensurable values, cents-level manipulation cost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  compile, startChain, deployProtocol, activateAgent, expectRevert, usdc, MNEMONIC,
} = require('./harness');

/// Local key for a node account, so a test can both sign EIP-712 payloads and send the
/// transaction from that same address (agent-scoped operations require both).
const localKey = (index) =>
  require('ethers').HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);

let chain;
let artifacts;
let p;
let agentA; // activated agent, owned by wallets[2]
let agentB; // activated agent, owned by wallets[3]

test.before(async () => {
  artifacts = compile({ quiet: true }).artifacts;
  chain = await startChain();
  p = await deployProtocol(chain, artifacts);
  agentA = await activateAgent(p, { signer: p.agentA, uri: 'ipfs://agentA.json', score: 92 });
  agentB = await activateAgent(p, { signer: p.agentB, uri: 'ipfs://agentB.json', score: 74 });
  // A third staked agent used as an independent reviewer, so review-rate limits in one
  // test cannot leak into another.
  await activateAgent(p, { signer: p.reviewer, uri: 'ipfs://reviewer.json', score: 88 });
  // Feedback rate limit is a Sybil brake, not a test obstacle.
  await (await p.reputation.setFeedbackCooldown(0)).wait();
});

test.after(async () => {
  await chain.stop();
});

// ---------------------------------------------------------------------------
// C2 — GROUNDING: unstaked, unpriced feedback cannot be written at all
// ---------------------------------------------------------------------------

test('grounding: an unstaked wallet cannot post feedback (the Sybil bench)', async () => {
  await expectRevert(
    p.reputation.connect(p.outsider).giveFeedback(
      agentA, 500, 2, 'starred', 'demo', 'https://agent.example', 'ipfs://feedback.json', ethers.ZeroHash,
    ),
    'UngroundedFeedback',
    p.reputation,
  );
});

test('grounding: a staked reviewer with an active agent can post feedback', async () => {
  const tx = await p.reputation.connect(p.agentB).giveFeedback(
    agentA, 480, 2, 'starred', 'research', 'https://agent.example', 'ipfs://fb-1.json', ethers.keccak256(ethers.toUtf8Bytes('fb-1')),
  );
  const receipt = await tx.wait();
  const events = receipt.logs
    .map((log) => { try { return p.reputation.interface.parseLog(log); } catch { return null; } })
    .filter(Boolean);

  const given = events.find((e) => e.name === 'FeedbackGiven');
  assert.ok(given, 'FeedbackGiven emitted');
  assert.equal(given.args.groundedByStake, true);
  assert.equal(given.args.groundedByPayment, false);
  assert.equal(given.args.value, 480n);

  // The canonical ERC-8004 event is emitted too, so existing 8004 indexers see it.
  assert.ok(events.some((e) => e.name === 'NewFeedback'), 'NewFeedback emitted for 8004 compatibility');

  const [value, decimals, tag1, tag2, revoked] = await p.reputation.readFeedback(agentA, p.agentB.address, 0);
  assert.equal(value, 480n);
  assert.equal(decimals, 2n);
  assert.equal(tag1, 'starred');
  assert.equal(tag2, 'research');
  assert.equal(revoked, false);
});

test('grounding: feedback citing a verified x402 payment works without stake', async () => {
  const payer = p.challenger; // no agent, no stake — but it really paid
  const paymentRef = ethers.keccak256(ethers.toUtf8Bytes('x402-payment-1'));
  await (await p.reputation.attestPayment(
    paymentRef, agentA, payer.address, p.addresses.usdc, usdc(25), Math.floor(Date.now() / 1000),
  )).wait();

  await (await p.reputation.connect(payer).giveFeedbackWithPayment(
    agentA, 450, 2, 'starred', 'paid-task', 'https://agent.example', 'ipfs://fb-2.json', ethers.ZeroHash,
    { paymentRef },
  )).wait();

  const record = await p.reputation.readFeedbackFull(agentA, payer.address, 0);
  assert.equal(record.groundedByPayment, true);
  assert.equal(record.groundedByStake, false);
  assert.equal(record.value, 450n);

  // A payment grounds exactly one record.
  await expectRevert(
    p.reputation.connect(payer).giveFeedbackWithPayment(
      agentA, 450, 2, 'starred', 'replay', '', '', ethers.ZeroHash, { paymentRef },
    ),
    'PaymentNotAttested',
    p.reputation,
  );
});

test('grounding: only a registered prover may attest payments', async () => {
  const paymentRef = ethers.keccak256(ethers.toUtf8Bytes('unverified'));
  await expectRevert(
    p.reputation.connect(p.outsider).attestPayment(
      paymentRef, agentA, p.outsider.address, p.addresses.usdc, usdc(10), Math.floor(Date.now() / 1000),
    ),
    'UngroundedFeedback',
    p.reputation,
  );
});

test('grounding: payment attestation must clear the minimum size', async () => {
  const paymentRef = ethers.keccak256(ethers.toUtf8Bytes('dust'));
  await expectRevert(
    p.reputation.attestPayment(paymentRef, agentA, p.outsider.address, p.addresses.usdc, 1n, Math.floor(Date.now() / 1000)),
    'PaymentTooSmall',
    p.reputation,
  );
});

test('grounding: atomic x402 settlement (EIP-3009) verifies the balance delta onchain', async () => {
  // The payer is msg.sender: the registry pulls the signed authorization *from the
  // caller*, which is what makes the balance-delta check meaningful.
  const buyer = localKey(8); // == p.lender address; can sign locally and send from the node account
  await (await p.usdc.mint(buyer.address, usdc(500))).wait();

  const amount = usdc(12);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600;
  const payTo = p.agentA.address; // agent wallet fallback == owner address

  const signature = await buyer.signTypedData(
    { name: 'USD Coin', version: '2', chainId: 31337, verifyingContract: p.addresses.usdc },
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    { from: buyer.address, to: payTo, value: amount, validAfter, validBefore, nonce },
  );
  const sig = ethers.Signature.from(signature);

  const payToBefore = await p.usdc.balanceOf(payTo);
  await (await p.reputation.connect(p.lender).giveFeedbackWithX402Settlement(
    agentA, 500, 2, 'starred', 'x402', 'https://agent.example', 'ipfs://fb-x402.json', ethers.ZeroHash,
    amount, validAfter, validBefore, nonce, sig.serialized,
  )).wait();
  const payToAfter = await p.usdc.balanceOf(payTo);
  assert.equal(payToAfter - payToBefore, amount, 'agent received the x402 payment');

  const record = await p.reputation.readFeedbackFull(agentA, buyer.address, 0);
  assert.equal(record.groundedByPayment, true);
  assert.equal(await p.usdc.authorizationState(buyer.address, nonce), true);
});

// ---------------------------------------------------------------------------
// C1 — COMMENSURABILITY: fixed tag set, fixed decimals, fixed range
// ---------------------------------------------------------------------------

test('commensurability: a tag outside the spec set is rejected', async () => {
  await expectRevert(
    p.reputation.connect(p.agentB).giveFeedback(
      agentA, 100, 0, 'trustworthy', 'vibes', '', '', ethers.ZeroHash,
    ),
    'TagNotAllowed',
    p.reputation,
  );
});

test('commensurability: values are range-checked per tag', async () => {
  await expectRevert(
    p.reputation.connect(p.agentB).giveFeedback(agentA, 600, 2, 'starred', '', '', '', ethers.ZeroHash),
    'ValueOutOfRange',
    p.reputation,
  );
  await expectRevert(
    p.reputation.connect(p.agentB).giveFeedback(agentA, 10_001, 2, 'uptime', '', '', '', ethers.ZeroHash),
    'ValueOutOfRange',
    p.reputation,
  );
});

test('commensurability: decimals are fixed per tag (no unit ambiguity)', async () => {
  await expectRevert(
    p.reputation.connect(p.agentB).giveFeedback(agentA, 480, 0, 'starred', '', '', '', ethers.ZeroHash),
    'WrongDecimals',
    p.reputation,
  );
});

test('commensurability: the tag spec is readable onchain', async () => {
  const spec = await p.reputation.tagSpec('starred');
  assert.equal(spec.enabled, true);
  assert.equal(Number(spec.decimals), 2);
  assert.equal(spec.minValue, 0n);
  assert.equal(spec.maxValue, 500n);
});

test('commensurability: getSummary is a plain mean only because values share a scale', async () => {
  // agentA has 4.80 (agentB, staked) and 4.50 (challenger, paid) → 4.65
  const [count, value, decimals] = await p.reputation.getSummary(
    agentA, [p.agentB.address, p.challenger.address], 'starred', '',
  );
  assert.equal(count, 2n);
  assert.equal(value, 465n);
  assert.equal(decimals, 2n);
});

test('commensurability: getSummary honours tag filters and requires an explicit reviewer set', async () => {
  const [count] = await p.reputation.getSummary(agentA, [p.agentB.address], 'uptime', '');
  assert.equal(count, 0n, 'no uptime feedback recorded');

  await expectRevert(p.reputation.getSummary(agentA, [], 'starred', ''), 'EmptyReviewerList', p.reputation);
});

// ---------------------------------------------------------------------------
// C3 — COSTLY MANIPULATION
// ---------------------------------------------------------------------------

test('anti-Sybil: an agent owner cannot review its own agent', async () => {
  await expectRevert(
    p.reputation.connect(p.agentA).giveFeedback(agentA, 500, 2, 'starred', '', '', '', ethers.ZeroHash),
    'SelfReview',
    p.reputation,
  );
});

test('anti-Sybil: the agent wallet cannot review the agent either', async () => {
  // bind a wallet to agentB and try to review agentB from it
  const wallet = localKey(8); // node account: can sign the binding and send the review
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const sig = await wallet.signTypedData(
    { name: 'AvairaIdentityRegistry', version: '1', chainId: 31337, verifyingContract: p.addresses.identity },
    { AgentWalletSet: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ] },
    { agentId: agentB, newWallet: wallet.address, deadline },
  );
  await (await p.identity.connect(p.agentB).setAgentWallet(agentB, wallet.address, deadline, sig)).wait();
  await expectRevert(
    p.reputation.connect(p.lender).giveFeedback(agentB, 500, 2, 'starred', '', '', '', ethers.ZeroHash),
    'SelfReview',
    p.reputation,
  );
  await (await p.identity.connect(p.agentB).unsetAgentWallet(agentB)).wait();
});

test('anti-Sybil: a reviewer below the reviewer-stake minimum cannot post', async () => {
  const small = await activateAgent(p, { signer: p.lender, uri: 'ipfs://small.json', stakeAmount: usdc(10), score: 90 });
  await expectRevert(
    p.reputation.connect(p.lender).giveFeedback(agentA, 500, 2, 'starred', 'lowstake', '', '', ethers.ZeroHash),
    'UngroundedFeedback',
    p.reputation,
  );
  void small;
});

test('anti-Sybil: a PENDING agent (score below floor) cannot review', async () => {
  const pending = await activateAgent(p, { signer: p.outsider, uri: 'ipfs://pending.json', stakeAmount: usdc(200), score: 30 });
  await expectRevert(
    p.reputation.connect(p.outsider).giveFeedback(agentA, 500, 2, 'starred', 'pending', '', '', ethers.ZeroHash),
    'UngroundedFeedback',
    p.reputation,
  );
  void pending;
});

test('anti-Sybil: the cooldown rate-limits feedback bursts', async () => {
  await (await p.reputation.setFeedbackCooldown(3600)).wait();
  await chain.increaseTime(3700); // clear any earlier review by this reviewer
  await (await p.reputation.connect(p.agentB).giveFeedback(agentA, 500, 2, 'starred', '', '', '', ethers.ZeroHash)).wait();
  await expectRevert(
    p.reputation.connect(p.agentB).giveFeedback(agentA, 500, 2, 'starred', '', '', '', ethers.ZeroHash),
    'FeedbackCooldownActive',
    p.reputation,
  );
  // Leave the shared fixture as it was found: other tests post review bursts.
  await (await p.reputation.setFeedbackCooldown(0)).wait();
  await (await p.reputation.setFeedbackCooldown(0)).wait();
});

test('revoke + response + readFeedback behave per spec', async () => {
  await (await p.reputation.connect(p.reviewer).giveFeedback(agentA, 300, 2, 'uptime', 'audit', '', 'ipfs://fb-3.json', ethers.ZeroHash)).wait();
  const index = Number(await p.reputation.feedbackCount(agentA, p.reviewer.address)) - 1;

  await (await p.reputation.connect(p.reviewer).revokeFeedback(agentA, index)).wait();
  const [, , , , revoked] = await p.reputation.readFeedback(agentA, p.reviewer.address, index);
  assert.equal(revoked, true);
  assert.equal(await p.reputation.feedbackCount(agentA, p.reviewer.address), BigInt(index + 1));

  // The reviewed agent answers the (revoked) rating; responses are hash-anchored.
  await (await p.reputation.connect(p.agentA).appendResponse(
    agentA, p.reviewer.address, index, 'ipfs://response.json', ethers.keccak256(ethers.toUtf8Bytes('response')),
  )).wait();
  assert.equal(await p.reputation.responseCount(agentA, p.reviewer.address, index), 1n);

  // Revoked records drop out of the summary.
  const [count] = await p.reputation.getSummary(agentA, [p.reviewer.address], 'uptime', '');
  assert.equal(count, 0n, 'revoked feedback excluded from summaries');
});

// ---------------------------------------------------------------------------
// C4 — the score is derived, never purchased
// ---------------------------------------------------------------------------

test('score: only the scorer role can post a score', async () => {
  await expectRevert(
    p.reputation.connect(p.outsider).postAvairaScore(agentA, 100, ethers.ZeroHash),
    'NotScorer',
    p.reputation,
  );
});

test('score: the scorer posts a 0–100 score with a breakdown hash and a grade', async () => {
  const breakdown = ethers.keccak256(ethers.toUtf8Bytes('breakdown:successRate=0.97,...'));
  const tx = await p.reputation.postAvairaScore(agentA, 92, breakdown);
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((log) => { try { return p.reputation.interface.parseLog(log); } catch { return null; } })
    .filter(Boolean).find((e) => e.name === 'ScorePosted');
  assert.equal(parsed.args.score, 92n);
  assert.equal(parsed.args.grade, 'A+');
  assert.equal(await p.reputation.scoreOf(agentA), 92n);
  assert.equal(await p.reputation.gradeOf(agentA), 'A+');
  assert.equal(await p.reputation.scoreBreakdownOf(agentA), breakdown);
  assert.equal(await p.reputation.hasScore(agentA), true);
  assert.equal(await p.reputation.isScoreStale(agentA), false);
});

test('score: grades map per the documented bands', async () => {
  const gradesAgent = await activateAgent(p, { signer: p.lender, uri: 'ipfs://grades.json', score: 50 });
  const bands = [[100, 'A+'], [90, 'A+'], [89, 'A'], [80, 'A'], [79, 'B'], [70, 'B'], [69, 'C'], [60, 'C'], [59, 'D'], [0, 'D']];
  for (const [score, grade] of bands) {
    await (await p.reputation.postAvairaScore(gradesAgent, score, ethers.ZeroHash)).wait();
    assert.equal(await p.reputation.gradeOf(gradesAgent), grade, `score ${score} → ${grade}`);
  }
});

test('score: out-of-range scores are rejected', async () => {
  await expectRevert(p.reputation.postAvairaScore(agentB, 101, ethers.ZeroHash), 'ScoreOutOfRange', p.reputation);
});

test('score: the six documented weights are published onchain', async () => {
  const weights = await p.reputation.scoreWeights();
  assert.deepEqual(weights.map(Number), [3000, 2000, 2000, 1500, 1000, 500]);
});

test('score: batch posting works for a leaderboard refresh', async () => {
  await (await p.reputation.postAvairaScoreBatch(
    [agentA, agentB], [91, 76], [ethers.ZeroHash, ethers.ZeroHash],
  )).wait();
  assert.equal(await p.reputation.scoreOf(agentA), 91n);
  assert.equal(await p.reputation.scoreOf(agentB), 76n);
});

test('score: raw feedback cannot move the score by itself', async () => {
  const before = await p.reputation.scoreOf(agentA);
  for (let i = 0; i < 5; i++) {
    await (await p.reputation.connect(p.reviewer).giveFeedback(
      agentA, 500, 2, 'starred', `spam-${i}`, '', '', ethers.ZeroHash,
    )).wait();
  }
  assert.equal(await p.reputation.scoreOf(agentA), before, 'score unchanged by five perfect ratings');
});
