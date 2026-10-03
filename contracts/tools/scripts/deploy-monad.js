#!/usr/bin/env node
/**
 * Avaira deployment — one script, two networks.
 *
 *   node tools/scripts/deploy-monad.js                    # dry run on the in-process EVM
 *   MONAD_RPC_URL=https://testnet-rpc.monad.xyz \
 *   DEPLOYER_PRIVATE_KEY=0x... node tools/scripts/deploy-monad.js --network monad-testnet
 *
 * Deploys all six components, wires them exactly as the test harness does (the wiring is
 * the part that silently breaks a protocol), optionally seeds the credit market's
 * liquidity pool, and writes a manifest that the verify script consumes:
 *
 *   deployments/monad-testnet.json   addresses, tx hashes, gas per contract, constructor
 *                                    args, compiler settings, block numbers
 *
 * The dry run is not decoration: it executes the same code path against a real EVM, so a
 * missing authorisation (the vault must be a slasher, for instance) fails here rather than
 * on testnet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const h = require('../e2e/harness');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOYMENTS = path.resolve(ROOT, '..', 'deployments');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const NETWORK = flag('network', 'local');
const RPC = flag('rpc') || process.env.MONAD_RPC_URL || null;
const KEY = process.env.DEPLOYER_PRIVATE_KEY || flag('key') || null;
const BOND = ethers.parseEther(String(flag('bond', '0.01'))); // registration bond in MON
const POOL_SEED = BigInt(flag('pool', '50000000000')); // 50,000 USDC (6 decimals)
const TREASURY = flag('treasury', null);

const GAS = {
  register: 250_000n,
  commitIntent: 350_000n,
  attestOutcome: 120_000n,
  giveFeedback: 300_000n,
  recordGateCheck: 90_000n,
};

/** ABI-encode a contract's constructor arguments for the explorer's verification form. */
function encodeConstructorArgs(artifact, argsList) {
  const ctor = artifact.abi.find((item) => item.type === 'constructor');
  if (!ctor || ctor.inputs.length === 0) return '';
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(ctor.inputs.map((i) => i.type), argsList).slice(2);
}

async function main() {
  const artifacts = h.compile({ quiet: true }).artifacts;
  const isLocal = NETWORK === 'local';
  let chain;
  let deployer;
  let submit;

  if (isLocal) {
    chain = await h.startChain();
    deployer = chain.wallets[0];
    submit = async (contract, method, ...callArgs) => {
      const tx = await contract[method](...callArgs);
      return tx.wait();
    };
  } else {
    if (!RPC) throw new Error('MONAD_RPC_URL (or --rpc) is required for --network ' + NETWORK);
    if (!KEY) throw new Error('DEPLOYER_PRIVATE_KEY is required for --network ' + NETWORK);
    const provider = new ethers.JsonRpcProvider(RPC);
    deployer = new ethers.Wallet(KEY, provider);
    chain = {
      provider,
      rawProvider: provider,
      wallets: Array.from({ length: 9 }, () => deployer),
      now: async () => Number(BigInt((await provider.getBlock('latest')).timestamp)),
      increaseTime: async () => {},
      balanceOf: async (a) => BigInt(await provider.getBalance(a)),
      stop: async () => {},
    };
    const net = await provider.getNetwork();
    console.log(`# network ${NETWORK} chainId ${net.chainId} rpc ${RPC}`);
    console.log(`# deployer ${deployer.address} balance ${ethers.formatEther(await provider.getBalance(deployer.address))} MON`);
    if ((await provider.getBalance(deployer.address)) === 0n) {
      throw new Error('deployer has no MON: fund it from the Monad testnet faucet first');
    }
  }

  const A = artifacts;
  const steps = [];
  const record = async (label, promise, artifact, argsList) => {
    const contract = await promise;
    const tx = contract.deploymentTransaction();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`deploy failed: ${label}`);
    steps.push({
      label,
      contractName: artifact?.contractName ?? label,
      address: receipt.contractAddress,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: Number(receipt.gasUsed),
      constructorArgs: artifact ? encodeConstructorArgs(artifact, argsList ?? []) : '',
    });
    console.log(`  ${label.padEnd(26)} ${receipt.contractAddress}  gas ${receipt.gasUsed}`);
    return contract;
  };

  // Locally the signer deliberately never estimates gas, so deploys carry the harness
  // ceiling; on a real network the node estimates as usual.
  const deploy = (artifact, argsList, overrides = {}) =>
    new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer)
      .deploy(...argsList, isLocal ? { gasLimit: h.DEPLOY_GAS, ...overrides } : overrides);

  console.log(`\n# deploying Avaira (${steps.length === 0 ? 'fresh' : 'existing'}) to ${NETWORK}`);
  const usdc = await record('MockUSDC (test liquidity)', deploy(A.MockUSDC, []), A.MockUSDC, []);
  const usdcAddr = await usdc.getAddress();
  const treasury = TREASURY || deployer.address;

  const identityArgs = [deployer.address, treasury, BOND];
  const identity = await record(
    'AvairaIdentityRegistry',
    deploy(A.AvairaIdentityRegistry, identityArgs),
    A.AvairaIdentityRegistry,
    identityArgs,
  );
  const stakeArgs = [deployer.address, usdcAddr, treasury];
  const stake = await record('AvairaStakeRegistry', deploy(A.AvairaStakeRegistry, stakeArgs), A.AvairaStakeRegistry, stakeArgs);
  const identityAddr = await identity.getAddress();
  const stakeAddr = await stake.getAddress();
  const reputationArgs = [deployer.address, usdcAddr, identityAddr];
  const reputation = await record(
    'AvairaReputationRegistry',
    deploy(A.AvairaReputationRegistry, reputationArgs),
    A.AvairaReputationRegistry,
    reputationArgs,
  );
  const validationArgs = [deployer.address, identityAddr];
  const validation = await record('AvairaValidationRegistry', deploy(A.AvairaValidationRegistry, validationArgs), A.AvairaValidationRegistry, validationArgs);
  const vaultArgs = [deployer.address, identityAddr, stakeAddr];
  const intentVault = await record('AvairaIntentVault', deploy(A.AvairaIntentVault, vaultArgs), A.AvairaIntentVault, vaultArgs);
  const creditArgs = [deployer.address, usdcAddr, identityAddr, stakeAddr, treasury];
  const credit = await record(
    'AvairaCreditMarket', deploy(A.AvairaCreditMarket, creditArgs), A.AvairaCreditMarket, creditArgs,
  );

  const addresses = {
    usdc: usdcAddr,
    identity: identityAddr,
    stake: stakeAddr,
    reputation: await reputation.getAddress(),
    validation: await validation.getAddress(),
    intentVault: await intentVault.getAddress(),
    credit: await credit.getAddress(),
  };

  // --- wiring: the same sequence the harness proves out --------------------
  console.log('\n# wiring');
  const wiring = [
    ['identity.setStakeRegistry', () => identity.setStakeRegistry(addresses.stake)],
    ['identity.setSlashAuthority', () => identity.setSlashAuthority(addresses.stake)],
    ['stake.setContracts', () => stake.setContracts(addresses.identity, addresses.reputation, addresses.intentVault)],
    ['reputation.setStakeRegistry', () => reputation.setStakeRegistry(addresses.stake)],
    ['reputation.setScorer', () => reputation.setScorer(deployer.address)],
    ['intentVault.setContracts', () => intentVault.setContracts(addresses.identity, addresses.stake)],
    ['stake.setSlasher(intentVault)', () => stake.setSlasher(addresses.intentVault, true)],
  ];
  const wiringRecords = [];
  for (const [label, fn] of wiring) {
    const receipt = await (await fn()).wait();
    wiringRecords.push({ label, txHash: receipt.hash, gasUsed: Number(receipt.gasUsed) });
    console.log(`  ${label.padEnd(34)} ${receipt.hash}`);
  }

  // --- seed the credit market's liquidity pool ------------------------------
  if (POOL_SEED > 0n) {
    console.log('\n# seeding the credit pool');
    await (await usdc.mint(deployer.address, POOL_SEED)).wait();
    await (await usdc.approve(addresses.credit, POOL_SEED)).wait();
    const receipt = await (await credit.depositLiquidity(POOL_SEED)).wait();
    wiringRecords.push({ label: 'credit.depositLiquidity', txHash: receipt.hash, gasUsed: Number(receipt.gasUsed) });
    console.log(`  pool seeded with ${POOL_SEED} USDC base units (${receipt.hash})`);
  }

  const solcVersion = require('solc').version().replace(/\.Emscripten\.clang$/, '');

  const manifest = {
    product: 'Avaira — accountability for the agent economy',
    network: NETWORK,
    chainId: Number((await chain.provider.getNetwork()).chainId),
    rpc: RPC || 'in-process',
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    treasury,
    registrationBondMon: ethers.formatEther(BOND),
    compiler: { solc: solcVersion, evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, viaIR: true },
    addresses,
    contracts: steps,
    wiring: wiringRecords,
  };

  fs.mkdirSync(DEPLOYMENTS, { recursive: true });
  const outFile = path.join(DEPLOYMENTS, `${NETWORK}.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${outFile}`);
  console.log('\n# next step: node tools/scripts/verify-monad.js --network ' + NETWORK);

  if (isLocal) {
    // Prove the wiring by driving a full agent lifecycle against the fresh deployment.
    console.log('\n# dry run: driving one agent lifecycle against the fresh deployment');
    const [owner] = chain.wallets;
    const receipt = await (await identity.connect(owner)['register(string)']('ipfs://deploy-dry-run.json', { value: BOND })).wait();
    const evt = receipt.logs
      .map((log) => { try { return identity.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed && parsed.name === 'Registered');
    const agentId = Number(evt.args.agentId);
    await (await usdc.mint(owner.address, 1_000_000_000n)).wait();
    await (await usdc.approve(addresses.stake, ethers.MaxUint256)).wait();
    await (await stake.connect(owner).stake(agentId, 200_000_000n)).wait();
    await (await reputation.connect(deployer).postAvairaScore(agentId, 88, ethers.ZeroHash)).wait();
    await (await stake.connect(owner).syncStatus(agentId)).wait();
    const [allowed, score] = await intentVault.checkGate(agentId);
    console.log(`  agent ${agentId} → gate allowed=${allowed} score=${score}`);
    if (!allowed) throw new Error('dry run failed: a freshly deployed protocol refused an A-grade agent');
    console.log('  dry run OK — deployment is wired correctly');
    await chain.stop();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
