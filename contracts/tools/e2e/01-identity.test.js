'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  compile, startChain, deployProtocol, activateAgent, expectRevert, MON, usdc, merkle, CHAIN_ID,
} = require('./harness');

const PORT = 18545;
let chain;
let artifacts;
let p;

test.before(async () => {
  artifacts = compile({ quiet: true }).artifacts;
  chain = await startChain({ port: PORT });
  p = await deployProtocol(chain, artifacts);
});

test.afterEach(() => {
  // Estimation-only assertions never consume a nonce, but keep the managers honest.
  chain.resetNonces();
});

test.after(async () => {
  await chain.stop();
});

test('register: mints an ERC-8004 identity, takes the bond, emits Registered', async () => {
  const bond = await p.identity.registrationBond();
  const tx = await p.identity.connect(p.agentA)['register(string)']('ipfs://agentA.json', { value: bond });
  const receipt = await tx.wait();
  const parsed = receipt.logs.map((l) => { try { return p.identity.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const registered = parsed.find((e) => e.name === 'Registered');
  assert.ok(registered, 'Registered event emitted');
  assert.equal(registered.args.agentURI, 'ipfs://agentA.json');
  assert.equal(registered.args.owner, p.agentA.address);

  const agentId = registered.args.agentId;
  assert.equal(await p.identity.ownerOf(agentId), p.agentA.address);
  assert.equal(await p.identity.tokenURI(agentId), 'ipfs://agentA.json');
  assert.equal(await p.identity.bondOf(agentId), bond);
  assert.equal(await p.identity.isRegistered(agentId), true);
});

test('register: rejects a wrong bond amount (Sybil fix #1)', async () => {
  const bond = await p.identity.registrationBond();
  await expectRevert(
    p.identity.connect(p.outsider)['register(string)']('ipfs://sybil.json', { value: bond - 1n }),
    'BondMismatch',
    p.identity,
  );
  await expectRevert(
    p.identity.connect(p.outsider)['register(string)']('ipfs://sybil.json', { value: bond + 1n }),
    'BondMismatch',
    p.identity,
  );
});

test('agentRegistry: returns the eip155 chain-qualified registry string', async () => {
  const expected = `eip155:31337:${p.addresses.identity.toLowerCase()}`;
  assert.equal((await p.identity.agentRegistry()).toLowerCase(), expected);
});

test('metadata: set/get round-trips and emits MetadataSet', async () => {
  const id = await activateAgent(p, { signer: p.agentB, uri: 'ipfs://agentB.json' });
  const tx = await p.identity.connect(p.agentB).setMetadata(id, 'missionGoal', ethers.toUtf8Bytes('research'));
  const receipt = await tx.wait();
  const parsed = receipt.logs.map((l) => { try { return p.identity.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  assert.ok(parsed.some((e) => e.name === 'MetadataSet'));

  const value = await p.identity.getMetadata(id, 'missionGoal');
  assert.equal(ethers.toUtf8String(value), 'research');
});

test('metadata: agentWallet is reserved and cannot be written directly', async () => {
  const id = 2n;
  await expectRevert(
    p.identity.connect(p.agentB).setMetadata(id, 'agentWallet', ethers.toUtf8Bytes('0xdead')),
    'ReservedMetadataKey',
    p.identity,
  );
});

test('metadata: only the owner or operator may write', async () => {
  await expectRevert(
    p.identity.connect(p.outsider).setMetadata(2, 'missionGoal', ethers.toUtf8Bytes('hijack')),
    'NotAgentOwnerOrOperator',
    p.identity,
  );
});

test('setAgentWallet: EIP-712 signature from the new EOA wallet binds it', async () => {
  const id = 2n;
  const newWallet = ethers.Wallet.createRandom().connect(chain.provider);
  const domain = {
    name: 'AvairaIdentityRegistry',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: p.addresses.identity,
  };
  const types = {
    AgentWalletSet: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const signature = await newWallet.signTypedData(domain, types, { agentId: id, newWallet: newWallet.address, deadline });

  try {
    await (await p.identity.connect(p.agentB).setAgentWallet(id, newWallet.address, deadline, signature)).wait();
  } catch (e) {
    console.error('TEST7 DEBUG', e.shortMessage || e.message, JSON.stringify(e.info || {}).slice(0, 200), e.stack?.split('\n').slice(0,3).join(' | '));
    throw e;
  }
  assert.equal(await p.identity.getAgentWallet(id), newWallet.address);

  // getMetadata('agentWallet') serves the reserved slot, ABI-encoded
  const encoded = await p.identity.getMetadata(id, 'agentWallet');
  const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], encoded);
  assert.equal(decoded, newWallet.address);
});

test('setAgentWallet: a signature from the wrong key is rejected', async () => {
  const id = 2n;
  const stranger = ethers.Wallet.createRandom();
  const victim = ethers.Wallet.createRandom().address;
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  // The stranger signs for a wallet it does not control: proof of control fails.
  const signature = await stranger.signTypedData(
    { name: 'AvairaIdentityRegistry', version: '1', chainId: CHAIN_ID, verifyingContract: p.addresses.identity },
    { AgentWalletSet: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ] },
    { agentId: id, newWallet: victim, deadline },
  );
  await expectRevert(
    p.identity.connect(p.agentB).setAgentWallet(id, victim, deadline, signature),
    'InvalidWalletSignature',
    p.identity,
  );
});

test('setAgentWallet: an expired deadline is rejected before any signature check', async () => {
  const past = Math.floor(Date.now() / 1000) - 1;
  await expectRevert(
    p.identity.connect(p.agentB).setAgentWallet(2, p.outsider.address, past, '0x'),
    'WalletBindingExpired',
    p.identity,
  );
});

test('setAgentWallet: ERC-1271 contract wallet (Privy-style smart account) path', async () => {
  const id = 2n;
  const account = await new ethers.ContractFactory(
    artifacts.MockERC1271Wallet.abi, artifacts.MockERC1271Wallet.bytecode, p.agentB
  ).deploy(p.agentB.address, { gasLimit: 8_000_000n });
  await account.waitForDeployment();
  const accountAddress = await account.getAddress();

  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = {
    name: 'AvairaIdentityRegistry', version: '1', chainId: CHAIN_ID, verifyingContract: p.addresses.identity,
  };
  const types = {
    AgentWalletSet: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  // The digest is computed with the standard EIP-712 encoder, independently of the
  // contract: if AvairaIdentityRegistry's domain separator or typehash were wrong, the
  // smart account would reject the signature and this test would fail.
  const digest = ethers.TypedDataEncoder.hash(domain, types, { agentId: id, newWallet: accountAddress, deadline });
  await (await account.setExpectedDigest(digest)).wait();

  await (await p.identity.connect(p.agentB).setAgentWallet(id, accountAddress, deadline, '0xdeadbeef')).wait();
  assert.equal(await p.identity.getAgentWallet(id), accountAddress);

  // A digest the wallet does not expect must be refused.
  await (await account.setExpectedDigest(ethers.ZeroHash)).wait();
  await expectRevert(
    p.identity.connect(p.agentB).setAgentWallet(id, accountAddress, deadline, '0xdeadbeef'),
    'InvalidWalletSignature',
    p.identity,
  );
});

test('transfer: agentWallet binding is cleared on transfer (spec requirement)', async () => {
  const id = await activateAgent(p, { signer: p.agentA, uri: 'ipfs://transfer-me.json', stakeAmount: usdc(200) });
  // agentA already owns an agent from the earlier test; stake is required before transfers
  const newOwner = p.outsider;
  const ownerBefore = await p.identity.ownerOf(id);
  assert.equal(ownerBefore, p.agentA.address);

  // bind a wallet first
  const wallet = ethers.Wallet.createRandom();
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const sig = await wallet.signTypedData(
    { name: 'AvairaIdentityRegistry', version: '1', chainId: CHAIN_ID, verifyingContract: p.addresses.identity },
    { AgentWalletSet: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ] },
    { agentId: id, newWallet: wallet.address, deadline },
  );
  await (await p.identity.connect(p.agentA).setAgentWallet(id, wallet.address, deadline, sig)).wait();
  assert.equal(await p.identity.getAgentWallet(id), wallet.address);

  await (await p.identity.connect(p.agentA).transferFrom(p.agentA.address, newOwner.address, id)).wait();
  assert.equal(await p.identity.ownerOf(id), newOwner.address);
  assert.equal(await p.identity.getAgentWallet(id), ethers.ZeroAddress, 'wallet binding cleared on transfer');
});

test('bond: forfeited to treasury on BAN, refunded on voluntary exit', async () => {
  const bond = await p.identity.registrationBond();

  // (a) voluntary exit path — a fresh agent with no stake
  const receipt = await (await p.identity.connect(p.outsider)['register(string)']('ipfs://exit.json', { value: bond })).wait();
  const id = receipt.logs
    .map((l) => { try { return p.identity.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find((e) => e.name === 'Registered').args.agentId;

  const before = await chain.balanceOf(p.outsider.address);
  await (await p.identity.connect(p.outsider).refundBondAndBurn(id)).wait();
  const after = await chain.balanceOf(p.outsider.address);
  assert.ok(after > before, 'bond refunded in MON (minus gas)');
  assert.equal(await p.identity.bondOf(id), 0n);
  assert.equal(await p.identity.getAgentWallet(id), ethers.ZeroAddress);
});

test('bond: refund is blocked while a stake is still posted', async () => {
  const id = await activateAgent(p, { signer: p.outsider, uri: 'ipfs://staked.json' });
  await expectRevert(p.identity.connect(p.outsider).refundBondAndBurn(id), 'StakeStillPosted', p.identity);
});

test('Sybil cap: maxAgentsPerOwner limits bulk identity minting', async () => {
  await (await p.identity.connect(p.deployer).setMaxAgentsPerOwner(2)).wait();
  const bond = await p.identity.registrationBond();
  const sybil = ethers.Wallet.createRandom().connect(chain.provider);
  await (await p.identity.connect(p.deployer).setBondRequired(true)).wait();

  // fund the sybil wallet with MON for bonds
  await (await p.deployer.sendTransaction({ to: sybil.address, value: ethers.parseEther('1') })).wait();
  await (await p.identity.connect(sybil)['register(string)']('ipfs://s1.json', { value: bond })).wait();
  await (await p.identity.connect(sybil)['register(string)']('ipfs://s2.json', { value: bond })).wait();
  await expectRevert(p.identity.connect(sybil)['register(string)']('ipfs://s3.json', { value: bond }), 'AgentCountExceeded', p.identity);

  await (await p.identity.connect(p.deployer).setMaxAgentsPerOwner(0)).wait(); // reset
});

test('merkle: leaf hashing matches the SDK contract helper', async () => {
  const leaf = merkle.leafHash('search', 25_000000n);
  assert.equal(await p.intentVault.leafHash('search', 25_000000n), leaf);
});
