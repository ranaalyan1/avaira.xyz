/**
 * Component 5 — AvairaStakeRegistry (lifecycle, slashing math, composability)
 * Component 6 — AvairaCreditMarket (score-gated credit)
 *
 * Component 5 is where reputation is made costly to fake: entry costs stake, and a
 * proven deviation costs 10/50/100% of it. The tests below pin the arithmetic exactly
 * (including the integer-division edges), verify that slashed value is conserved between
 * the challenger bounty and the treasury, and walk the NONE → PENDING → ACTIVE →
 * SUSPENDED → BANNED lifecycle plus the voluntary exit that refunds the identity bond.
 *
 * Component 6 is the bridge from reputation to capital: the same agent borrows at 110%
 * collateral at an A grade and 150% when ungraded. Lending is only opened to agents the
 * gate would also allow — a suspended or banned agent cannot borrow, and an open
 * position becomes liquidatable the moment its agent is punished.
 *
 * Foundry's fuzzer is unavailable in this environment (no binaries reachable), so the
 * slashing and Merkle arithmetic are exercised by a deterministic pseudo-random loop
 * with a fixed seed: same coverage intent, reproducible output. The Foundry port of the
 * same assertions lives in test/Avaira*.t.sol for the CI that has `forge`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  compile, startChain, deployProtocol, activateAgent, expectRevert, send, merkle, usdc,
} = require('./harness');

let chain;
let p;

const BPS = 10_000n;
const WARNING_BPS = 1_000n;
const SUSPENSION_BPS = 5_000n;
const BAN_BPS = 10_000n;
const BOUNTY_BPS = 5_000n;

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

/** Deterministic 32-bit PRNG (mulberry32) so fuzz-style loops are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test.before(async () => {
  const artifacts = compile({ quiet: true }).artifacts;
  chain = await startChain();
  p = await deployProtocol(chain, artifacts);
});

test.after(async () => {
  if (chain) await chain.stop();
});

/** Register + fund an agent without activating it (tests drive the lifecycle). */
async function registerAgent(signer, uri = 'ipfs://agent.json', mint = 1_000_000n) {
  const bond = await p.identity.registrationBond();
  const receipt = await (await p.identity.connect(signer)['register(string)'](uri, { value: bond })).wait();
  const evt = receipt.logs
    .map((log) => { try { return p.identity.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed && parsed.name === 'Registered');
  return Number(evt.args.agentId);
}

// ---------------------------------------------------------------------------
// Component 5 — lifecycle
// ---------------------------------------------------------------------------

test('the lifecycle walks NONE → PENDING → ACTIVE and back', async () => {
  const owner = p.agentA;
  const id = await registerAgent(owner, 'ipfs://lifecycle.json');

  assert.equal(await p.stake.statusOf(id), 0n, 'NONE before any stake');
  assert.equal(await p.stake['isEligible(uint256)'](id), false);

  // Stake below the minimum → PENDING, not ACTIVE.
  await (await p.stake.connect(owner).stake(id, 50_000_000n)).wait();
  assert.equal(await p.stake.statusOf(id), 1n, 'PENDING: stake below minimum');

  await (await p.stake.connect(owner).stake(id, usdc(100))).wait();
  assert.equal(await p.stake.statusOf(id), 1n, 'PENDING: no score yet');

  await (await p.reputation.connect(p.deployer).postAvairaScore(id, 75, hash('breakdown'))).wait();
  assert.equal(await p.stake.statusOf(id), 2n, 'ACTIVE: staked + scored');
  assert.equal(await p.stake['isEligible(uint256)'](id), true);
  assert.equal(await p.stake['isEligible(address)'](owner.address), true, 'address form is eligible');
  assert.equal(await p.stake.score(id), 75n);

  // Below the eligibility floor → back to PENDING.
  await (await p.reputation.connect(p.deployer).postAvairaScore(id, 59, hash('breakdown-2'))).wait();
  assert.equal(await p.stake.statusOf(id), 1n, 'PENDING: score below floor');
  assert.equal(await p.stake['isEligible(uint256)'](id), false);
});

test('stake requires owning the identity, and zero amounts are rejected', async () => {
  const id = await registerAgent(p.agentB, 'ipfs://stake-owner.json');
  await expectRevert(
    p.stake.connect(p.outsider).stake(id, usdc(100)),
    'NotAgentOwner',
    p.stake,
  );
  await expectRevert(
    p.stake.connect(p.agentB).stake(id, 0n),
    'ZeroAmount',
    p.stake,
  );
});

test('unstaking is subject to a cooldown and a request-first rule', async () => {
  const id = await registerAgent(p.reviewer, 'ipfs://unstake.json');
  await (await p.stake.connect(p.reviewer).stake(id, usdc(300))).wait();

  await expectRevert(
    p.stake.connect(p.reviewer).withdrawStake(id),
    'NothingToWithdraw',
    p.stake,
  );

  await (await p.stake.connect(p.reviewer).requestUnstake(id, usdc(100))).wait();
  await expectRevert(
    p.stake.connect(p.reviewer).withdrawStake(id),
    'NothingToWithdraw',
    p.stake,
  );
  await expectRevert(
    p.stake.connect(p.reviewer).requestUnstake(id, usdc(500)),
    'InsufficientStake',
    p.stake,
  );

  await chain.increaseTime(Number(await p.stake.unstakeCooldown()) + 60);
  const before = await p.usdc.balanceOf(p.reviewer.address);
  await (await p.stake.connect(p.reviewer).withdrawStake(id)).wait();
  assert.equal(await p.usdc.balanceOf(p.reviewer.address), before + usdc(100));
  assert.equal(await p.stake.stakeOf(id), usdc(200));
});

test('voluntary exit refunds the identity bond and burns the agent; banned agents cannot exit', async () => {
  const id = await registerAgent(p.challenger, 'ipfs://exit.json');
  await send(p.stake.connect(p.challenger).stake(id, usdc(150)), p.stake);

  // Exit is two-phase by construction: the first call files the request for the whole
  // balance (the cooldown cannot be skipped), the second call after it matures completes.
  const requestReceipt = await (await p.stake.connect(p.challenger).voluntaryExit(id)).wait();
  const requested = requestReceipt.logs
    .map((log) => { try { return p.stake.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'UnstakeRequested');
  assert.ok(requested, 'first call files the exit request');
  assert.equal(requested.args.amount, usdc(150));
  assert.equal(await p.stake.stakeOf(id), usdc(150), 'stake untouched while the cooldown runs');

  await chain.increaseTime(Number(await p.stake.unstakeCooldown()) + 60);

  const usdcBefore = await p.usdc.balanceOf(p.challenger.address);
  const monBefore = await chain.balanceOf(p.challenger.address);
  await (await p.stake.connect(p.challenger).voluntaryExit(id)).wait();

  assert.equal(await p.usdc.balanceOf(p.challenger.address), usdcBefore + usdc(150), 'stake refunded');
  assert.equal(await chain.balanceOf(p.challenger.address) > monBefore, true, 'registration bond refunded');
  assert.equal(await p.stake.statusOf(id), 0n);
  await expectRevert(p.identity.ownerOf(id), 'ERC721NonexistentToken', p.identity);

  // A banned agent has forfeited its bond: no exit for it.
  const banned = await registerAgent(p.lender, 'ipfs://banned-exit.json');
  await (await p.stake.connect(p.lender).stake(banned, usdc(150))).wait();
  await (await p.stake.connect(p.deployer).slash(banned, 2 /* BAN */, hash('ban-evidence'))).wait();
  await expectRevert(
    p.stake.connect(p.lender).voluntaryExit(banned),
    'AgentBanned',
    p.stake,
  );
});

// ---------------------------------------------------------------------------
// Component 5 — slashing math (fuzz-style, deterministic seed)
// ---------------------------------------------------------------------------

test('slash amounts are exact and conserved between bounty and treasury', async () => {
  const random = rng(0x5eed);
  const cases = [];
  for (let i = 0; i < 6; i++) {
    // A spread of stakes including a non-round number and a small one.
    cases.push(BigInt(Math.floor(1_000_000 + random() * 400_000_000)));
  }
  cases.push(usdc(200), 1n, 999_999_999n);

  for (const [index, stakeAmount] of cases.entries()) {
    const id = await registerAgent(index % 2 === 0 ? p.agentA : p.agentB, `ipfs://slash-case-${index}.json`);
    if (stakeAmount > 0n) await (await p.stake.connect(index % 2 === 0 ? p.agentA : p.agentB).stake(id, stakeAmount)).wait();

    const level = [0, 1, 2][index % 3];
    const bps = level === 0 ? WARNING_BPS : level === 1 ? SUSPENSION_BPS : BAN_BPS;
    const expected = (stakeAmount * bps) / BPS;

    const treasuryBefore = await p.usdc.balanceOf(p.treasury.address);
    const tx = await (await p.stake.connect(p.deployer).slash(id, level, hash(`evidence-${index}`))).wait();
    const parsed = tx.logs
      .map((log) => { try { return p.stake.interface.parseLog(log); } catch { return null; } })
      .find((event) => event && event.name === 'Slashed');
    assert.equal(parsed.args.amount, expected, `level ${level}: slashed == stake*bps/BPS (truncating)`);
    assert.equal(await p.stake.stakeOf(id), stakeAmount - expected, 'position reduced by exactly the slash');
    const treasuryAfter = await p.usdc.balanceOf(p.treasury.address);
    assert.equal(treasuryAfter - treasuryBefore, expected, 'un-challenged slash is protocol revenue');
  }
});

test('a challenged slash splits 50/50 and the remainder matches exactly', async () => {
  const random = rng(0xbadc0de);
  for (let i = 0; i < 4; i++) {
    const stakeAmount = BigInt(Math.floor(1_000_000 + random() * 900_000_000));
    const id = await registerAgent(p.reviewer, `ipfs://split-case-${i}.json`);
    await (await p.stake.connect(p.reviewer).stake(id, stakeAmount)).wait();

    const intentHash = hash(`split-intent-${i}`);
    const entries = [['swap', 10n], ['transfer', 999n]];
    const leaves = entries.map(([action, spend]) => merkle.leafHash(action, spend));
    const { root, layers } = merkle.buildTree(leaves);
    const deadline = (await chain.now()) + 3600;
    await (await p.intentVault.connect(p.reviewer).commitIntent(id, intentHash, {
      maxSpendUsd: 100n, allowedActions: ['swap'], deadline,
    })).wait();
    await (await p.intentVault.connect(p.reviewer).attestOutcome(id, intentHash, hash(`o-${i}`), root)).wait();

    const bond = await p.stake.challengerBond();
    await (await p.usdc.connect(p.challenger).approve(await p.stake.getAddress(), ethers.MaxUint256)).wait();
    const treasuryBefore = await p.usdc.balanceOf(p.treasury.address);
    const bountyBefore = await p.usdc.balanceOf(p.challenger.address);

    const proof = { action: 'transfer', spendUsd: 999n, leafIndex: 1n, merkleProof: merkle.proofFor(layers, 1) };
    await (await p.stake.connect(p.challenger).challengeDeviation(id, intentHash, proof)).wait();

    const slashed = (stakeAmount * BAN_BPS) / BPS; // unlisted action → BAN (100%)
    const bounty = (slashed * BOUNTY_BPS) / BPS;
    const treasuryDelta = (await p.usdc.balanceOf(p.treasury.address)) - treasuryBefore;
    const bountyDelta = (await p.usdc.balanceOf(p.challenger.address)) - bountyBefore;
    assert.equal(treasuryDelta, slashed - bounty, 'treasury gets the remainder');
    // The challenger's bond is posted and returned inside the same call, so the net
    // balance movement is exactly the bounty.
    assert.equal(bountyDelta, bounty, 'challenger receives the bounty');
    assert.equal(treasuryDelta + bountyDelta, slashed, 'slashed value is conserved');
  }
});

test('slashes are idempotent-safe: a banned agent cannot be banned twice', async () => {
  const id = await registerAgent(p.outsider, 'ipfs://ban-twice.json');
  await (await p.stake.connect(p.outsider).stake(id, usdc(200))).wait();
  await (await p.stake.connect(p.deployer).slash(id, 2, hash('ban-1'))).wait();
  assert.equal(await p.stake.statusOf(id), 4n, 'BANNED');
  await expectRevert(
    p.stake.connect(p.deployer).slash(id, 2, hash('ban-2')),
    'AlreadyBanned',
    p.stake,
  );
});

test('a suspension is reversible by governance, a ban never is', async () => {
  const id = await registerAgent(p.kimiValidator, 'ipfs://reinstate.json');
  await (await p.stake.connect(p.kimiValidator).stake(id, usdc(200))).wait();
  await (await p.reputation.connect(p.deployer).postAvairaScore(id, 90, hash('b'))).wait();
  assert.equal(await p.stake.statusOf(id), 2n);

  await (await p.stake.connect(p.deployer).slash(id, 1 /* SUSPENSION */, hash('susp-1'))).wait();
  assert.equal(await p.stake.statusOf(id), 3n, 'SUSPENDED');
  await expectRevert(
    p.stake.connect(p.deployer).reinstate(id + 999),
    'NotSuspended',
    p.stake,
  );
  await (await p.stake.connect(p.deployer).reinstate(id)).wait();
  // Score was not restored by the slash; it is still 90, so the agent is ACTIVE again.
  assert.equal(await p.stake.statusOf(id), 2n, 'reinstated');

  await (await p.stake.connect(p.deployer).slash(id, 2 /* BAN */, hash('ban-final'))).wait();
  assert.equal(await p.stake.statusOf(id), 4n);
  await expectRevert(
    p.stake.connect(p.deployer).reinstate(id),
    'NotSuspended',
    p.stake,
  );
});

test('only authorised slashers may slash directly', async () => {
  await expectRevert(
    p.stake.connect(p.outsider).slash(1, 0, hash('unauthorised')),
    'NotSlasher',
    p.stake,
  );
});

// ---------------------------------------------------------------------------
// Component 5 — Merkle verification fuzz (JS SDK format ↔ Solidity)
// ---------------------------------------------------------------------------

test('Merkle roots and proofs agree with the contract for random tree shapes', async () => {
  const random = rng(0xc0ffee);
  for (let round = 0; round < 12; round++) {
    const n = 1 + Math.floor(random() * 8);
    const entries = [];
    for (let i = 0; i < n; i++) {
      entries.push([`action-${Math.floor(random() * 5)}`, BigInt(Math.floor(random() * 1_000_000))]);
    }
    const leaves = entries.map(([action, spend]) => merkle.leafHash(action, spend));
    const { root, layers } = merkle.buildTree(leaves);

    for (let i = 0; i < n; i++) {
      const [action, spend] = entries[i];
      const proof = merkle.proofFor(layers, i);
      assert.equal(
        await p.intentVault.computeRoot(await p.intentVault.leafHash(action, spend), proof),
        root,
        `round ${round} leaf ${i}/${n}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Component 6 — score-gated credit
// ---------------------------------------------------------------------------

test('collateral ratios follow the documented score bands', async () => {
  const aGrade = await activateAgent(p, { signer: p.agentA, uri: 'ipfs://credit-a.json', score: 85 });
  const bGrade = await activateAgent(p, { signer: p.agentB, uri: 'ipfs://credit-b.json', score: 70 });
  const ungraded = await activateAgent(p, {
    signer: p.reviewer, uri: 'ipfs://credit-u.json', score: 0, stakeAmount: usdc(200),
  });
  await (await p.reputation.connect(p.deployer).postAvairaScore(ungraded, 0, hash('none'))).wait();

  assert.equal(await p.credit.collateralRatioBps(aGrade), 11_000n);
  assert.equal(await p.credit.tierOf(aGrade), 'A');
  assert.equal(await p.credit.collateralRatioBps(bGrade), 12_500n);
  assert.equal(await p.credit.tierOf(bGrade), 'B');
  assert.equal(await p.credit.collateralRatioBps(ungraded), 15_000n);
  assert.equal(await p.credit.tierOf(ungraded), 'UNRATED');

  const [required, ratio, score, tier] = await p.credit.quote(aGrade, usdc(1_000));
  assert.equal(required, usdc(1_100), '110% of principal');
  assert.equal(ratio, 11_000n);
  assert.equal(score, 85n);
  assert.equal(tier, 'A');

  const [requiredUngraded] = await p.credit.quote(ungraded, usdc(1_000));
  assert.equal(requiredUngraded, usdc(1_500), '150% when ungraded');
});

test('an A-grade agent borrows at 110% and repays with interest', async () => {
  const id = await activateAgent(p, { signer: p.kimiValidator, uri: 'ipfs://borrower.json', score: 88 });
  const principal = usdc(1_000);

  await expectRevert(
    p.credit.connect(p.kimiValidator).borrow(id, 0n),
    'ZeroAmount',
    p.credit,
  );
  await expectRevert(
    p.credit.connect(p.outsider).borrow(id, principal),
    'NotAgentOwner',
    p.credit,
  );

  const before = await p.usdc.balanceOf(p.kimiValidator.address);
  await (await p.credit.connect(p.kimiValidator).borrow(id, principal)).wait();
  // Collateral (110% of principal) is posted and the principal is disbursed in one call.
  assert.equal(
    await p.usdc.balanceOf(p.kimiValidator.address),
    before - usdc(1_100) + principal,
    'collateral out, principal in',
  );

  const loan = await p.credit.loanOf(id);
  assert.equal(loan.principal, principal);
  assert.equal(loan.collateral, usdc(1_100));
  assert.equal(await p.credit.scoreAtOrigination(id), 88n);

  await expectRevert(
    p.credit.connect(p.kimiValidator).borrow(id, usdc(10)),
    'LoanAlreadyOpen',
    p.credit,
  );
  await expectRevert(
    p.credit.connect(p.kimiValidator).withdrawCollateral(id),
    'LoanStillOpen',
    p.credit,
  );

  // Accrue 30 days of interest at 8% APR. The expected value is derived from the block
  // timestamps the chain actually used — asserting "exactly 30 days" would be flaky by
  // the one or two seconds each mined block adds.
  const openedAt = (await p.credit.loanOf(id)).openedAt;
  await chain.increaseTime(30 * 24 * 3600);
  const elapsed = BigInt(await chain.now()) - openedAt;
  assert.equal(elapsed >= 30n * 24n * 3600n, true, 'at least 30 days passed');
  const expectedInterest = (principal * 800n * elapsed) / (BPS * 365n * 24n * 3600n);
  const debt = await p.credit.debtOf(id);
  assert.equal(debt, principal + expectedInterest, 'interest = principal * APR * elapsed');

  const treasuryBefore = await p.usdc.balanceOf(p.treasury.address);
  await (await p.credit.connect(p.kimiValidator).repay(id)).wait();
  assert.equal(await p.credit.debtOf(id), 0n);
  assert.equal(
    (await p.usdc.balanceOf(p.treasury.address)) - treasuryBefore,
    (expectedInterest * 1_000n) / BPS,
    '10% reserve factor to the treasury',
  );

  const beforeWithdraw = await p.usdc.balanceOf(p.kimiValidator.address);
  await (await p.credit.connect(p.kimiValidator).withdrawCollateral(id)).wait();
  assert.equal(await p.usdc.balanceOf(p.kimiValidator.address), beforeWithdraw + usdc(1_100), 'collateral returned');
});

test('a suspended or banned agent cannot borrow, and its open loan can be liquidated', async () => {
  const id = await activateAgent(p, { signer: p.challenger, uri: 'ipfs://liquidatable.json', score: 90 });
  await send(p.credit.connect(p.challenger).borrow(id, usdc(500)), p.credit);

  const liquidatorBefore = await p.usdc.balanceOf(p.outsider.address);
  await expectRevert(
    p.credit.connect(p.outsider).liquidate(id),
    'Healthy',
    p.credit,
  );

  // The circuit breaker: one outage-level slash and the position is liquidatable.
  await (await p.stake.connect(p.deployer).slash(id, 1 /* SUSPENSION */, hash('outage'))).wait();
  await expectRevert(
    p.credit.connect(p.challenger).borrow(id, usdc(10)),
    'AgentNotEligibleForCredit',
    p.credit,
  );

  const idleBefore = await p.credit.availableLiquidity();
  const seized = await p.credit.connect(p.outsider).liquidate.staticCall(id);
  const ownerBefore = await p.usdc.balanceOf(p.challenger.address);
  await (await p.credit.connect(p.outsider).liquidate(id)).wait();

  assert.equal(seized, usdc(550), 'the whole collateral is seized');
  assert.equal(await p.usdc.balanceOf(p.outsider.address) > liquidatorBefore, true, 'keeper paid');
  assert.equal(await p.credit.debtOf(id), 0n, 'position closed');
  assert.equal((await p.credit.loanOf(id)).collateral, 0n);
  assert.equal(await p.credit.totalBadDebt(), 0n, 'fully collateralised: no bad debt');
  assert.equal(await p.credit.availableLiquidity() >= idleBefore, true, 'pool made whole');
  assert.equal(await p.usdc.balanceOf(p.challenger.address) > ownerBefore, true, 'excess collateral returned to the owner');
});

test('the credit market refuses a banned agent outright', async () => {
  const id = await activateAgent(p, { signer: p.lender, uri: 'ipfs://banned-borrow.json', score: 90 });
  await (await p.stake.connect(p.deployer).slash(id, 2 /* BAN */, hash('ban-credit'))).wait();
  const status = await p.stake.statusOf(id);
  await expectRevert(
    p.credit.connect(p.lender).borrow(id, usdc(100)),
    'AgentNotEligibleForCredit',
    p.credit,
  );
  assert.equal(status, 4n);
});
