#!/usr/bin/env node
/**
 * Avaira metrics harness — the numbers the submission has to publish, measured rather
 * than claimed.
 *
 *   node tools/metrics.js                  # in-process EVM (contract-side costs + gate timing)
 *   node tools/metrics.js --rpc <url> --key <hex>   # same report against Monad testnet
 *
 * What it measures:
 *   - gas per write path: commitIntent, attestOutcome, giveFeedback (staked and x402
 *     grounded), recordGateCheck, challengeDeviation, and the identity registration;
 *   - the same gas in MON and USD at the gas price actually reported by the chain
 *     (--mon-usd overrides the reference price, --gwei overrides the gas price);
 *   - gate latency: the commit → checkGate → attest round trip, and the standalone
 *     checkGate call the SDK makes in front of every action (p50 / p95 / max);
 *   - how many intents the gate can clear per minute at the measured latency.
 *
 * Nothing here is hard-coded: every figure is read back from a receipt or a stopwatch.
 * The in-process run isolates the contract's own cost; the --rpc run is the number that
 * belongs in the write-up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const h = require('./e2e/harness');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const RPC = flag('rpc');
const KEY = flag('key') || process.env.DEPLOYER_PRIVATE_KEY || null;
const MON_USD = Number(flag('mon-usd') || process.env.MON_USD || 3.0);
const GWEI_OVERRIDE = flag('gwei') ? Number(flag('gwei')) : null;
const OUT = flag('out') || path.join(__dirname, 'metrics.json');

const USDC_DECIMALS = 6;
const fmtUsd = (x) => `$${x.toFixed(x < 0.01 ? 6 : 4)}`;
const fmtMon = (x) => `${x.toFixed(9)} MON`;

/** Gas of a send, with the receipt attached. */
async function gasOf(txPromise) {
  const receipt = await (await txPromise).wait();
  return { gasUsed: Number(receipt.gasUsed), receipt };
}

async function measure(label, times, fn) {
  const samples = [];
  let last;
  for (let i = 0; i < times; i++) {
    last = await fn(i);
    samples.push({ gas: last.gasUsed, hash: last.receipt.hash });
  }
  const gasList = samples.map((s) => s.gas);
  return {
    label,
    runs: times,
    gas: gasList,
    min: Math.min(...gasList),
    max: Math.max(...gasList),
    avg: Math.round(gasList.reduce((a, b) => a + b, 0) / gasList.length),
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  const usingRpc = Boolean(RPC);
  let chain;
  let p;

  if (usingRpc) {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(KEY, provider);
    console.log(`# Avaira metrics — external RPC ${RPC}`);
    console.log(`# signer ${wallet.address}`);
    const artifacts = h.compile({ quiet: true }).artifacts;
    chain = {
      provider,
      rawProvider: provider,
      wallets: Array.from({ length: 9 }, () => wallet),
      now: async () => Number(BigInt((await provider.getBlock('latest')).timestamp)),
      increaseTime: async () => { throw new Error('not available on an external chain'); },
      balanceOf: async (a) => BigInt(await provider.getBalance(a)),
      stop: async () => {},
    };
    // Roles are all the same key on an external run; a single-agent measurement is
    // enough to price the write paths, and the gate timing is what matters there.
    p = await h.deployProtocol(chain, artifacts);
    console.log('# NOTE: on an external chain every role uses the deployer key; the gas');
    console.log('# figures are the contract costs, not a multi-agent simulation.');
    console.log('# Ensure the key holds testnet MON (registration bond + gas) and that the');
    console.log('# network allows deploying the in-repo MockUSDC used for USDC-denominated paths.');
  } else {
    const artifacts = h.compile({ quiet: true }).artifacts;
    chain = await h.startChain();
    p = await h.deployProtocol(chain, artifacts);
  }

  const deployer = usingRpc ? chain.wallets[0] : p.deployer;
  const agentA = usingRpc ? chain.wallets[0] : p.agentA;
  const agentB = usingRpc ? chain.wallets[0] : p.agentB;

  const results = { network: usingRpc ? RPC : 'in-process-evm', chainId: (await chain.provider.getNetwork()).chainId.toString(), measurements: {} };

  // Gas price + MON price reference for the USD column.
  const feeData = await chain.provider.getFeeData();
  let gasPriceWei = GWEI_OVERRIDE ? BigInt(Math.round(GWEI_OVERRIDE * 1e9)) : (feeData.gasPrice ?? 0n);
  if (gasPriceWei === 0n) gasPriceWei = 1_000_000_000n; // 1 gwei fallback for an in-process node
  results.gasPriceGwei = Number(gasPriceWei) / 1e9;
  results.monUsd = MON_USD;
  const cost = (gas) => {
    const mon = Number(gasPriceWei * BigInt(gas)) / 1e18;
    return { mon, usd: mon * MON_USD };
  };

  // --- setup: two active agents -------------------------------------------
  const bond = await p.identity.registrationBond();
  const registerTx = await h.gasOf(p.identity.connect(agentA)['register(string)']('ipfs://metrics-a.json', { value: bond }));
  results.measurements.registerAgent = { gas: registerTx.gasUsed };

  const agentAId = await h.activateAgent(p, { signer: agentA, uri: 'ipfs://metrics-a.json', score: 92 });
  const agentBId = await h.activateAgent(p, { signer: agentB, uri: 'ipfs://metrics-b.json', score: 74 });
  await (await p.reputation.connect(p.deployer).setFeedbackCooldown(0)).wait();

  // --- gas: commitIntent / attestOutcome -----------------------------------
  const intentHashes = [];
  results.measurements.commitIntent = await measure('commitIntent', 5, async (i) => {
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`metrics-intent-${i}-${Date.now()}`));
    intentHashes.push(intentHash);
    const deadline = (await chain.now()) + 3600;
    return gasOf(p.intentVault.connect(agentA).commitIntent(agentAId, intentHash, {
      maxSpendUsd: 250n, allowedActions: ['swap', 'bridge'], deadline,
    }));
  });

  results.measurements.attestOutcome = await measure('attestOutcome', 5, async (i) => {
    const entries = [['swap', BigInt(10 + i)], ['bridge', BigInt(20 + i)], ['swap', BigInt(30 + i)]];
    const leaves = entries.map(([a, s]) => h.merkle.leafHash(a, s));
    const { root } = h.merkle.buildTree(leaves);
    const intentHash = intentHashes[i];
    return gasOf(p.intentVault.connect(agentA).attestOutcome(
      agentAId, intentHash, ethers.keccak256(ethers.toUtf8Bytes(`outcome-${i}`)), root,
    ));
  });

  // --- gas: feedback (staked + x402 grounded) ------------------------------
  results.measurements.giveFeedbackStaked = await measure('giveFeedback (staked reviewer)', 5, async (i) =>
    gasOf(p.reputation.connect(agentB).giveFeedback(
      agentAId, BigInt(480 - i), 2, 'starred', 'metrics', 'https://agent.example',
      `ipfs://feedback-${i}.json`, ethers.ZeroHash,
    )));

  // x402: the payer signs an EIP-3009 authorization and the registry settles it atomically.
  if (!usingRpc) {
    const amount = BigInt(2_000_000); // 2 USDC
    results.measurements.giveFeedbackX402 = await measure('giveFeedbackWithX402Settlement', 3, async (i) => {
      // Sign typed data with the local key but send through the node account: the node
      // manages the nonce, so repeated measurements cannot race themselves.
      const payerWallet = h.localWallet(8);
      const payer = p.lender;
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const now = await chain.now();
      const validAfter = now - 60;
      const validBefore = now + 3600;
      const domain = { name: 'USD Coin', version: '2', chainId: Number(results.chainId), verifyingContract: p.addresses.usdc };
      const types = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      };
      const signature = await payerWallet.signTypedData(
        domain, types,
        { from: payer.address, to: agentA.address, value: amount, validAfter, validBefore, nonce },
      );
      return gasOf(p.reputation.connect(payer).giveFeedbackWithX402Settlement(
        agentAId, BigInt(500 - i), 2, 'starred', 'x402', 'https://agent.example',
        `ipfs://x402-${i}.json`, ethers.ZeroHash,
        amount, validAfter, validBefore, nonce, signature,
      ));
    });
  }

  // --- gas: the onchain gate record + the challenge path --------------------
  results.measurements.recordGateCheck = await measure('recordGateCheck (onchain event)', 5, async () =>
    gasOf(p.intentVault.connect(deployer).recordGateCheck(agentAId)));

  if (!usingRpc) {
    const challengerId = await h.activateAgent(p, { signer: p.challenger, uri: 'ipfs://metrics-deviant.json', score: 80 });
    const entries = [['swap', 40n], ['transfer', 5_000n]];
    const leaves = entries.map(([a, s]) => h.merkle.leafHash(a, s));
    const { root, layers } = h.merkle.buildTree(leaves);
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes('metrics-deviation'));
    await (await p.intentVault.connect(p.challenger).commitIntent(challengerId, intentHash, {
      maxSpendUsd: 100n, allowedActions: ['swap'], deadline: (await chain.now()) + 3600,
    })).wait();
    await (await p.intentVault.connect(p.challenger).attestOutcome(
      challengerId, intentHash, ethers.keccak256(ethers.toUtf8Bytes('metrics-deviation-outcome')), root,
    )).wait();
    await (await p.usdc.connect(p.challenger).approve(await p.stake.getAddress(), ethers.MaxUint256)).wait();
    const proof = { action: 'transfer', spendUsd: 5_000n, leafIndex: 1n, merkleProof: h.merkle.proofFor(layers, 1) };
    results.measurements.challengeDeviation = await measure('challengeDeviation (Merkle proof)', 1, async () =>
      gasOf(p.stake.connect(p.challenger).challengeDeviation(challengerId, intentHash, proof)));
  }

  // --- latency: the SDK's hot path ----------------------------------------
  const rounds = usingRpc ? 5 : 20;
  const gateSamples = [];
  const roundTripSamples = [];
  const commitSamples = [];

  for (let i = 0; i < rounds; i++) {
    // (a) the free view call the SDK makes before it executes anything
    const t0 = process.hrtime.bigint();
    const [allowed, score] = await p.intentVault.checkGate(agentAId);
    const t1 = process.hrtime.bigint();
    if (!allowed) throw new Error(`gate refused an active agent (score ${score})`);
    gateSamples.push(Number(t1 - t0) / 1e6);

    // (b) the full commit → gate → attest round trip the SDK performs per task
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`latency-intent-${i}`));
    const deadline = (await chain.now()) + 3600;
    const t2 = process.hrtime.bigint();
    await (await p.intentVault.connect(agentA).commitIntent(agentAId, intentHash, {
      maxSpendUsd: 100n, allowedActions: ['swap'], deadline,
    })).wait();
    const t3 = process.hrtime.bigint();
    commitSamples.push(Number(t3 - t2) / 1e6);

    const [ok] = await p.intentVault.checkGate(agentAId);
    if (!ok) throw new Error('gate refused mid-round-trip');

    const leaves = [h.merkle.leafHash('swap', 42n)];
    const { root } = h.merkle.buildTree(leaves);
    await (await p.intentVault.connect(agentA).attestOutcome(
      agentAId, intentHash, ethers.keccak256(ethers.toUtf8Bytes(`latency-outcome-${i}`)), root,
    )).wait();
    const t4 = process.hrtime.bigint();
    roundTripSamples.push(Number(t4 - t2) / 1e6);
  }

  // --- throughput: how many gate checks clear per minute -------------------
  const burstSeconds = usingRpc ? 3 : 5;
  const burstStart = process.hrtime.bigint();
  let checks = 0;
  while (Number(process.hrtime.bigint() - burstStart) / 1e9 < burstSeconds) {
    await p.intentVault.checkGate(agentAId);
    checks += 1;
  }
  const burstElapsed = Number(process.hrtime.bigint() - burstStart) / 1e9;

  // Same thing, but issued concurrently — the way a fleet of agents would hit the gate.
  const concurrent = usingRpc ? 50 : 250;
  const concurrentRounds = usingRpc ? 3 : 5;
  const concurrentStart = process.hrtime.bigint();
  let concurrentChecks = 0;
  for (let r = 0; r < concurrentRounds; r++) {
    await Promise.all(Array.from({ length: concurrent }, () => p.intentVault.checkGate(agentAId)));
    concurrentChecks += concurrent;
  }
  const concurrentElapsed = Number(process.hrtime.bigint() - concurrentStart) / 1e9;
  const parallelLatencies = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 25 }, () => p.intentVault.checkGate(agentAId)));
    parallelLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6 / 25);
  }

  results.latency = {
    gateCheckMs: {
      p50: percentile(gateSamples, 50),
      p95: percentile(gateSamples, 95),
      max: Math.max(...gateSamples),
      samples: gateSamples.length,
    },
    commitTxMs: {
      p50: percentile(commitSamples, 50),
      p95: percentile(commitSamples, 95),
      max: Math.max(...commitSamples),
    },
    roundTripMs: {
      p50: percentile(roundTripSamples, 50),
      p95: percentile(roundTripSamples, 95),
      max: Math.max(...roundTripSamples),
      samples: roundTripSamples.length,
    },
    gateChecksPerMinute: Math.round((checks / burstElapsed) * 60),
    measuredOverSeconds: burstElapsed,
    gateChecksPerMinuteConcurrent: Math.round((concurrentChecks / concurrentElapsed) * 60),
    gateCheckPerCallMsUnderLoad: {
      p50: percentile(parallelLatencies, 50),
      p95: percentile(parallelLatencies, 95),
    },
    concurrentBatch: concurrent,
    concurrentRounds,
  };

  // --- report --------------------------------------------------------------
  const lines = [];
  const push = (s = '') => { lines.push(s); console.log(s); };

  push('');
  push(`## Avaira measured metrics — ${usingRpc ? RPC : 'in-process EVM harness'}`);
  push('');
  push(`Gas price used: ${results.gasPriceGwei} gwei · MON reference price: $${MON_USD} (override with --mon-usd)`);
  push('');
  push('| Write path | gas (avg) | gas (max) | MON | USD |');
  push('| --- | ---: | ---: | ---: | ---: |');
  for (const key of Object.keys(results.measurements)) {
    const m = results.measurements[key];
    const gas = m.avg ?? m.gas;
    const c = cost(gas);
    push(`| ${m.label ?? key} | ${gas.toLocaleString()} | ${(m.max ?? gas).toLocaleString()} | ${fmtMon(c.mon)} | ${fmtUsd(c.usd)} |`);
  }
  push('');
  push('| Gate latency (SDK hot path) | ms |');
  push('| --- | ---: |');
  push(`| checkGate (view, p50) | ${results.latency.gateCheckMs.p50.toFixed(2)} |`);
  push(`| checkGate (view, p95) | ${results.latency.gateCheckMs.p95.toFixed(2)} |`);
  push(`| commitIntent tx (p50, includes block) | ${results.latency.commitTxMs.p50.toFixed(2)} |`);
  push(`| commit → gate → attest round trip (p50) | ${results.latency.roundTripMs.p50.toFixed(2)} |`);
  push(`| commit → gate → attest round trip (p95) | ${results.latency.roundTripMs.p95.toFixed(2)} |`);
  push(`| gate checks per minute (sequential, one client) | ${results.latency.gateChecksPerMinute.toLocaleString()} |`);
  push(`| gate checks per minute (concurrent, ${results.latency.concurrentRounds}×${results.latency.concurrentBatch} in flight) | ${results.latency.gateChecksPerMinuteConcurrent.toLocaleString()} |`);
  push(`| checkGate per call under concurrency (p50/p95) | ${results.latency.gateCheckPerCallMsUnderLoad.p50.toFixed(2)} / ${results.latency.gateCheckPerCallMsUnderLoad.p95.toFixed(2)} |`);
  push('');
  push(usingRpc
    ? 'Source: Monad testnet RPC round trips, measured by this script.'
    : 'Source: in-process EVM. Contract-side costs are chain-independent; the latency column is the');
  if (!usingRpc) push('lower bound and excludes network round trips — re-run with --rpc on Monad for the published figure.');

  results.report = lines.join('\n');
  fs.writeFileSync(OUT, JSON.stringify(results, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
  fs.writeFileSync(OUT.replace(/\.json$/, '.md'), `${results.report}\n`);
  console.log(`\nwrote ${OUT} and ${OUT.replace(/\.json$/, '.md')}`);
  await chain.stop();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
