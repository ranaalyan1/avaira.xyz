#!/usr/bin/env node
/**
 * Avaira end-to-end harness.
 *
 * Compiles the Foundry sources with solc-js (see lib/compile.js), boots an in-process
 * EVM, deploys the full six-component stack and hands tests a wired-up protocol object.
 * This is the executed-evidence layer: `forge test` is the primary suite, this harness
 * runs the same behaviours in environments without the Foundry binaries, and the deploy
 * scripts reuse it so the bytecode that is tested is the bytecode that ships.
 *
 * Ports are fixed per suite so parallel test files do not collide.
 */
'use strict';

const ganache = require('ganache');
const { ethers } = require('ethers');
const { compile } = require('../lib/compile');

// ganache deterministic mnemonic (same as `ganache --deterministic`)
const MNEMONIC = 'myth like bonus scare over problem client lizard pioneer submit female collect';
const CHAIN_ID = 31337;

const USDC = 1_000_000n; // 1 USDC (6 decimals)

/// Deployment gas ceiling. Ganache rejects very large explicit limits ("could not
/// coalesce error"), and our largest constructor needs ~2.5M gas, so 8M is comfortable.
const DEPLOY_GAS = 8_000_000n;

/// Per-transaction gas ceiling used for every call send.
const DEFAULT_TX_GAS = 3_000_000n;
const MON = 10n ** 18n;

function usdc(n) {
  return BigInt(Math.round(n * 1e6));
}

/**
 * Thin wrapper over a node-managed account.
 *
 * ethers' JsonRpcSigner is frozen and only exposes getAddress(), while the harness and
 * the SDK bootstrap pass signers around as `{ address, sendTransaction, ... }`. This
 * adapts one to the other without hiding any capability.
 */
class NodeSigner {
  #inner;

  constructor(inner, address) {
    this.#inner = inner;
    this.address = address;
  }

  get provider() {
    return this.#inner.provider;
  }

  get inner() {
    return this.#inner;
  }

  getAddress() {
    return Promise.resolve(this.address);
  }

  getNonce(blockTag) {
    return this.#inner.getNonce(blockTag);
  }

  async sendTransaction(tx) {
    // Everything goes through our populator first. Without this, ethers falls through to
    // the inner signer, which calls eth_estimateGas (see estimateGas below) and turns a
    // perfectly good reverting call into an undecodable "missing revert data" error.
    const pop = await this.populateTransaction(tx);
    try {
      return await this.#inner.sendTransaction(pop);
    } catch (err) {
      // The inner signer reports a mined revert with the calldata stripped; put the full
      // call back on the error so expectRevert can re-simulate it and decode the custom
      // error (this EVM does not return revert data for a status-0 receipt).
      if (err && typeof err === 'object') {
        const info = { from: pop.from, to: pop.to, data: pop.data, value: pop.value, gasLimit: pop.gasLimit };
        try {
          err.transaction = { ...(err.transaction || {}), ...info };
        } catch { /* frozen error object */ }
        err.avairaTx = { ...(err.transaction || {}), ...info };
      }
      throw err;
    }
  }

  signTransaction(tx) {
    return this.#inner.signTransaction(tx);
  }

  signMessage(message) {
    return this.#inner.signMessage(message);
  }

  signTypedData(domain, types, value) {
    return this.#inner.signTypedData(domain, types, value);
  }

  /**
   * Sends always carry an explicit gas limit.
   *
   * This EVM's `eth_estimateGas` intermittently fails on calls with dynamic arguments
   * (it returns an error with no revert data, so even the reason is lost). Gas limits
   * are fixed instead: a call that would revert is mined, reverts, and surfaces on the
   * receipt — which `expectRevert` decodes. Deterministic, and closer to mainnet
   * behaviour than a node that refuses to estimate.
   */
  populateTransaction(tx) {
    return this.#inner.populateTransaction({ ...tx, gasLimit: tx.gasLimit ?? DEFAULT_TX_GAS });
  }

  /**
   * Gas is never estimated on this node.
   *
   * Both ethers (for the gas limit) and the contract method populate path call
   * `estimateGas`, and this EVM's `eth_estimateGas` fails outright on calls that would
   * revert with a custom error carrying dynamic arguments — it returns an error with no
   * revert data, so even the reason is lost and a legitimate revert becomes
   * indistinguishable from a broken node. Every send therefore gets a fixed ceiling and
   * a reverting call is simply mined (status 0), which `expectRevert` decodes precisely.
   */
  estimateGas() {
    return Promise.resolve(DEFAULT_TX_GAS);
  }

  call(tx) {
    return this.#inner.call(tx);
  }

  connect(provider) {
    return new NodeSigner(this.#inner.connect(provider), this.address);
  }

  get provider() {
    return this.#inner.provider ?? null;
  }
}

// Last chain started in this process; gives expectRevert a raw provider for the
// read-only re-simulation it needs to decode custom errors.
let RAW_PROVIDER = null;

async function startChain({ chainId = 31337, port } = {}) {
  void port; // accepted for backwards compatibility; the VM is in-process

  // In-process EVM, no HTTP server.
  //
  // Ganache's HTTP/WebSocket transport falls back to a degraded JS implementation on
  // Node 22 and drops ~half of its requests (empty response body, which ethers surfaces
  // as "could not coalesce error"). Driving the same VM in-process over EIP-1193 is
  // both reliable and ~10x faster, and it removes ports from the test setup entirely.
  const provider = ganache.provider({
    logging: { quiet: true },
    wallet: { mnemonic: MNEMONIC, totalAccounts: 12 },
    chain: { chainId, hardfork: 'shanghai', allowUnlimitedContractSize: true },
    miner: { blockGasLimit: 90_000_000 },
  });

  if (process.env.AVAIRA_RPC_LOG) {
    const origRequest = provider.request.bind(provider);
    provider.request = async (args) => {
      const { method, params } = args;
      let out;
      try {
        out = await origRequest(args);
      } catch (err) {
        const p0 = Array.isArray(params) ? params[0] : params;
        console.log(`[rpc] ${method} FAILED:`, (err.message || '').slice(0, 120),
          typeof p0 === 'string' ? p0 : JSON.stringify({ from: p0?.from, to: p0?.to, data: String(p0?.data || '').slice(0, 10), gas: p0?.gas }));
        throw err;
      }
      if (method === 'eth_sendTransaction') {
        console.log('[rpc] send', String(params?.[0]?.data || '').slice(0, 10), 'from', params?.[0]?.from, 'gas', params?.[0]?.gas);
      }
      return out;
    };
  }

  RAW_PROVIDER = provider;

  const browser = new ethers.BrowserProvider(provider, chainId);

  // Signers are node-managed accounts (eth_sendTransaction), so ganache owns nonce and
  // fee selection: no drift, no fee races. Offline EIP-712 signing in tests uses plain
  // ethers Wallet objects, which never touch the RPC layer.
  const wallets = [];
  for (let i = 0; i < 12; i++) {
    const signer = await browser.getSigner(i);
    wallets.push(new NodeSigner(signer, await signer.getAddress()));
  }

  return {
    provider: browser,
    rawProvider: provider,
    wallets,
    async mine() {
      await provider.request({ method: 'evm_mine', params: [] });
    },
    /** Balance read straight from the VM (no block-tag caching). */
    async balanceOf(address) {
      return BigInt(await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }));
    },
    async increaseTime(seconds) {
      await provider.request({ method: 'evm_increaseTime', params: [seconds] });
      await provider.request({ method: 'evm_mine', params: [] });
    },
    async snapshot() {
      return provider.request({ method: 'evm_snapshot', params: [] });
    },
    async revert(id) {
      await provider.request({ method: 'evm_revert', params: [id] });
    },
    resetNonces() {},
    async stop() {},
  };
}

async function deploy(artifact, signer, args = [], overrides = {}) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args, { gasLimit: DEPLOY_GAS, ...overrides });
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`deployment transaction missing for ${artifact.contractName}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`deployment failed: ${artifact.contractName}`);
  if (!receipt.contractAddress) throw new Error(`no contract address in receipt: ${artifact.contractName}`);
  return new ethers.Contract(receipt.contractAddress, artifact.abi, signer);
}

async function deployProtocol(chain, artifacts, opts = {}) {
  const [deployer, treasury, agentA, agentB, reviewer, challenger, outsider, kimiValidator, lender] = chain.wallets;
  const A = artifacts;

  // Step-tagged execution: any failure reports exactly which deployment or wiring call
  // broke, which is the difference between a 30-second fix and an hour of guessing.
  let step = 'init';
  async function run(name, fn) {
    step = name;
    try {
      return await fn();
    } catch (err) {
      err.step = name;
      throw err;
    }
  }
  const addresses = {};

  const usdcToken = await run('deploy MockUSDC', () => deploy(A.MockUSDC, deployer));
  const usdcAddr = await usdcToken.getAddress();

  const identity = await run('deploy IdentityRegistry', () =>
    deploy(A.AvairaIdentityRegistry, deployer, [deployer.address, treasury.address, opts.registrationBond ?? MON / 100n]));
  const stake = await run('deploy StakeRegistry', () =>
    deploy(A.AvairaStakeRegistry, deployer, [deployer.address, usdcAddr, treasury.address]));
  const identityAddr = await identity.getAddress();
  const stakeAddr = await stake.getAddress();
  const reputation = await run('deploy ReputationRegistry', () =>
    deploy(A.AvairaReputationRegistry, deployer, [deployer.address, usdcAddr, identityAddr]));
  const validation = await run('deploy ValidationRegistry', () =>
    deploy(A.AvairaValidationRegistry, deployer, [deployer.address, identityAddr]));
  const intentVault = await run('deploy IntentVault', () =>
    deploy(A.AvairaIntentVault, deployer, [deployer.address, identityAddr, stakeAddr]));
  const credit = await run('deploy CreditMarket', () =>
    deploy(A.AvairaCreditMarket, deployer, [
      deployer.address,
      usdcAddr,
      identityAddr,
      stakeAddr,
      treasury.address,
    ]));

  Object.assign(addresses, {
    usdc: usdcAddr,
    identity: identityAddr,
    stake: stakeAddr,
    reputation: await reputation.getAddress(),
    validation: await validation.getAddress(),
    intentVault: await intentVault.getAddress(),
    credit: await credit.getAddress(),
  });

  const wiring = [
    ['wire identity.setStakeRegistry', () => identity.setStakeRegistry(addresses.stake)],
    ['wire identity.setSlashAuthority', () => identity.setSlashAuthority(addresses.stake)],
    ['wire stake.setContracts', () => stake.setContracts(addresses.identity, addresses.reputation, addresses.intentVault)],
    ['wire reputation.setStakeRegistry', () => reputation.setStakeRegistry(addresses.stake)],
    ['wire reputation.setScorer', () => reputation.setScorer(deployer.address)],
    ['wire intentVault.setContracts', () => intentVault.setContracts(addresses.identity, addresses.stake)],
  ];
  for (const [name, fn] of wiring) {
    await run(name, async () => {
      const tx = await fn();
      await tx.wait();
    });
  }

  await run('fund wallets', async () => {
    for (const wallet of chain.wallets) {
      await (await usdcToken.connect(wallet).mint(wallet.address, usdc(1_000_000))).wait();
      // Pre-approve every protocol contract that pulls USDC, as an SDK bootstrap would.
      for (const spender of [stake, reputation, credit]) {
        await (await usdcToken.connect(wallet).approve(await spender.getAddress(), ethers.MaxUint256)).wait();
      }
    }
  });

  return {
    usdc: usdcToken,
    identity,
    stake,
    reputation,
    validation,
    intentVault,
    credit,
    addresses,
    chain,
    deployer,
    treasury,
    agentA,
    agentB,
    reviewer,
    challenger,
    outsider,
    kimiValidator,
    lender,
  };
}

/**
 * Registers an agent identity (bond required), stakes USDC and posts a score so the
 * agent reaches ACTIVE. Mirrors exactly what the SDK bootstrap does.
 */
async function activateAgent(p, { signer, agentId = 0, stakeAmount = usdc(200), score = 90, uri = 'ipfs://agent.json' }) {
  const identity = p.identity.connect(signer);
  const stakeReg = p.stake.connect(signer);
  const bond = await p.identity.registrationBond();

  let id = agentId;
  if (id === 0) {
    const receipt = await (await identity['register(string)'](uri, { value: bond })).wait();
    const evt = receipt.logs
      .map((log) => { try { return p.identity.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed && parsed.name === 'Registered');
    id = Number(evt.args.agentId);
  }

  await (await stakeReg.stake(id, stakeAmount)).wait();
  await (await p.reputation.connect(p.deployer).postAvairaScore(id, score, ethers.ZeroHash)).wait();
  await (await p.stake.connect(signer).syncStatus(id)).wait();
  return id;
}

// ---------------------------------------------------------------------------
// Merkle helpers — must match libraries/MerkleLib.sol exactly
// ---------------------------------------------------------------------------

const coder = ethers.AbiCoder.defaultAbiCoder();

function leafHash(action, spendUsd) {
  return ethers.keccak256(coder.encode(['string', 'uint256'], [action, spendUsd]));
}

function hashPair(a, b) {
  return BigInt(a) < BigInt(b)
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('no leaves');
  const layers = [leaves.slice()];
  let layer = layers[0];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 === layer.length ? layer[i] : hashPair(layer[i], layer[i + 1]));
    }
    layers.push(next);
    layer = next;
  }
  return { root: layer[0], layers };
}

function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Convenience: audit trail → {root, proofFor(action, spend)} */
function buildAuditTree(entries) {
  const leaves = entries.map((e) => leafHash(e.action, e.spendUsd));
  const { layers } = buildTree(leaves);
  return {
    root: layers[layers.length - 1][0],
    leaves,
    proofFor(index) {
      return proofFor(layers, index);
    },
    proofForEntry(action, spendUsd) {
      const idx = entries.findIndex((e) => e.action === action && BigInt(e.spendUsd) === BigInt(spendUsd));
      if (idx < 0) throw new Error('entry not found in trail');
      return { proof: proofFor(layers, idx), index: idx };
    },
  };
}

/**
 * Assert that a call reverts, and that it reverts with the expected custom error.
 *
 * Two shapes are handled, because they differ by node:
 *   - estimation-time revert: the promise rejects before broadcast (Hardhat, some RPCs);
 *   - execution-time revert: the node accepts and mines the transaction, so the failure
 *     surfaces on `receipt.wait()` (ganache's node-managed accounts).
 * When the revert data is not attached to the error, the call is re-simulated through
 * `eth_call` to recover it, so assertions check the actual custom error rather than a
 * substring of a message.
 */
async function expectRevert(promise, matcher, context) {
  const iface = context?.interface ?? context;

  const interpret = async (err, tx) => {
    let raw =
      err?.info?.data?.result ||
      err?.info?.error?.data?.result ||
      (typeof err?.data === 'string' ? err.data : null) ||
      (typeof err?.info?.data === 'string' ? err.info.data : null) ||
      null;

    // A rejected send (a mined status-0 receipt, or an estimate that gave up without
    // data) still carries the exact call, so re-execute it read-only and decode.
    let txInfo = tx || err?.avairaTx || err?.transaction || err?.info?.transaction || null;
    const raw0 = context?.runner?.provider ?? context?.provider ?? RAW_PROVIDER;
    if (!raw && raw0 && err?.receipt?.hash && !txInfo?.data) {
      try {
        const sent = await raw0.request({ method: 'eth_getTransactionByHash', params: [err.receipt.hash] });
        if (sent?.to && sent?.input) txInfo = { ...txInfo, to: sent.to, from: sent.from, data: sent.input };
      } catch { /* fall through to the message matcher */ }
    }
    if (!raw) {
      if (raw0 && txInfo.to && txInfo.data) {
        try {
          // Re-execute the same call against the *pre-transaction* state where possible.
          const call = {
            to: txInfo.to,
            from: txInfo.from,
            data: txInfo.data,
            value: txInfo.value ?? undefined,
            gasLimit: txInfo.gasLimit ?? undefined,
          };
          if (typeof raw0.call === 'function') {
            await raw0.call(call);
          } else {
            const params = [{ to: call.to, from: call.from, data: call.data }];
            if (call.value != null) params[0].value = ethers.toBeHex(call.value);
            if (call.gasLimit != null) params[0].gas = ethers.toBeHex(call.gasLimit);
            await raw0.request({ method: 'eth_call', params: [params[0], 'latest'] });
          }
        } catch (callErr) {
          raw =
            callErr?.info?.data?.result ||
            (typeof callErr?.data === 'string' ? callErr.data : null) ||
            raw;
        }
      }
    }

    let decodedName = null;
    let decodedArgs = null;
    if (raw && iface?.parseError) {
      try {
        const parsed = iface.parseError(raw);
        if (parsed) {
          decodedName = parsed.name;
          decodedArgs = parsed.args;
        }
      } catch { /* not one of ours */ }
    }

    if (decodedName !== null) {
      if (matcher && decodedName.toLowerCase() !== String(matcher).toLowerCase()) {
        const args = decodedArgs ? Array.from(decodedArgs).map(String).join(', ') : '';
        throw new Error(`expected revert "${matcher}", got "${decodedName}(${args})"`);
      }
      return { name: decodedName, args: decodedArgs, raw };
    }

    const message = String(err?.shortMessage || err?.message || err);
    if (matcher && !message.toLowerCase().includes(String(matcher).toLowerCase())) {
      throw new Error(`expected revert containing "${matcher}", got: ${message}`);
    }
    return { name: null, args: null, raw, message };
  };

  let tx;
  try {
    tx = await promise;
  } catch (err) {
    return interpret(err, null);
  }

  if (tx && typeof tx.wait === 'function') {
    try {
      const receipt = await tx.wait();
      if (receipt && receipt.status === 0) {
        return interpret(new Error('transaction reverted onchain'), tx);
      }
    } catch (err) {
      return interpret(err, tx);
    }
    throw new Error('expected revert, transaction succeeded');
  }

  throw new Error('expected a reverting transaction, got no transaction response');
}

async function gasOf(txPromise) {
  const receipt = await (await txPromise).wait();
  return { gasUsed: receipt.gasUsed, receipt };
}

module.exports = {
  CHAIN_ID,
  compile,
  startChain,
  deploy,
  deployProtocol,
  activateAgent,
  expectationHelpers: { expectRevert, gasOf },
  merkle: { leafHash, hashPair, buildTree, proofFor, buildAuditTree },
  expectRevert,
  gasOf,
  usdc,
  USDC,
  MON,
  MNEMONIC,
};
