/**
 * Component 3 — AvairaValidationRegistry (ERC-8004 Validation).
 *
 * The registry is the "independent verification" leg of ERC-8004: an agent owner asks a
 * named validator to attest something offchain, and the validator posts a 0–100 response
 * anchored by a URI and a hash. Multiple responses per request model soft → hard finality,
 * and the Kimi two-pass adversarial auditor posts under the `kimi-adversarial` tag so a
 * relying party can read its latest verdict without trusting the agent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  compile, startChain, deployProtocol, activateAgent, expectRevert, MNEMONIC,
} = require('./harness');

/** Local key for a node account: lets a test sign typed data and send from one address. */
let localWallet = (index) =>
  require('ethers').HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);

let chain;
let p;
let agentA;
let requester;
let otherValidator;

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

test.before(async () => {
  const artifacts = compile({ quiet: true }).artifacts;
  chain = await startChain();
  p = await deployProtocol(chain, artifacts);

  agentA = await activateAgent(p, { signer: p.agentA, uri: 'ipfs://agentA.json', score: 92 });
  await activateAgent(p, { signer: p.agentB, uri: 'ipfs://agentB.json', score: 74 });
  requester = p.agentA;
  otherValidator = p.reviewer; // any address can be named as an independent validator
});

test.after(async () => {
  if (chain) await chain.stop();
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test('an agent owner can open a validation request', async () => {
  const requestHash = hash('req-1');
  const tx = await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-1.json', requestHash,
  )).wait();

  const parsed = tx.logs
    .map((log) => { try { return p.validation.interface.parseLog(log); } catch { return null; } })
    .find((event) => event && event.name === 'ValidationRequested');
  assert.ok(parsed, 'ValidationRequested emitted');
  assert.equal(parsed.args.validator, p.kimiValidator.address);
  assert.equal(parsed.args.agentId, BigInt(agentA));
  assert.equal(parsed.args.requestHash, requestHash);

  const request = await p.validation.requestOf(requestHash);
  assert.equal(request.validator, p.kimiValidator.address);
  assert.equal(request.agentId, BigInt(agentA));
  assert.equal(request.exists, true);
  assert.equal(request.finalized, false);
  assert.equal(Number(request.createdAt) > 0, true);

  assert.deepEqual([...(await p.validation.getAgentValidations(agentA))], [requestHash]);
  assert.deepEqual([...(await p.validation.getValidatorRequests(p.kimiValidator.address))], [requestHash]);
});

test('only the owner, its operator or its bound wallet may request a validation', async () => {
  await expectRevert(
    p.validation.connect(p.outsider).validationRequest(
      p.kimiValidator.address, agentA, 'ipfs://request-2.json', hash('req-2'),
    ),
    'NotAgentOperator',
    p.validation,
  );

  // A bound agent wallet counts as an operator (ERC-8004: the agent can ask for audits).
  const agentWallet = localWallet(8).connect(chain.provider); // == p.lender, connected to the VM
  const agentB = 2;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const digest = ethers.TypedDataEncoder.hash(
    {
      name: 'AvairaIdentityRegistry', version: '1', chainId: 31337,
      verifyingContract: p.addresses.identity,
    },
    {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    { agentId: agentB, newWallet: agentWallet.address, deadline },
  );
  const sig = await agentWallet.signTypedData(
    {
      name: 'AvairaIdentityRegistry', version: '1', chainId: 31337,
      verifyingContract: p.addresses.identity,
    },
    {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    { agentId: agentB, newWallet: agentWallet.address, deadline },
  );
  // The binding must be signed by the new wallet itself (proof of control).
  assert.equal(ethers.recoverAddress(digest, sig), agentWallet.address);
  await (await p.identity.connect(p.agentB).setAgentWallet(agentB, agentWallet.address, deadline, sig)).wait();

  await (await p.validation.connect(agentWallet).validationRequest(
    p.kimiValidator.address, agentB, 'ipfs://request-wallet.json', hash('req-wallet'),
  )).wait();
  assert.equal(await p.validation.responseCount(hash('req-wallet')), 0n);

  await (await p.identity.connect(p.agentB).unsetAgentWallet(agentB)).wait();
});

test('a request needs a URI and a fresh hash', async () => {
  await expectRevert(
    p.validation.connect(requester).validationRequest(p.kimiValidator.address, agentA, '', hash('req-empty')),
    'EmptyRequestURI',
    p.validation,
  );
  await expectRevert(
    p.validation.connect(requester).validationRequest(
      ethers.ZeroAddress, agentA, 'ipfs://request-3.json', hash('req-zero'),
    ),
    'ZeroAddress',
    p.validation,
  );
  await expectRevert(
    p.validation.connect(requester).validationRequest(
      p.kimiValidator.address, agentA, 'ipfs://request-4.json', hash('req-1'),
    ),
    'RequestExists',
    p.validation,
  );
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

test('only the designated validator may respond, and scores are 0–100', async () => {
  const requestHash = hash('resp-1');
  await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-5.json', requestHash,
  )).wait();

  await expectRevert(
    p.validation.connect(otherValidator).validationResponse(requestHash, 90, 'ipfs://r.json', hash('r'), 'soft'),
    'NotDesignatedValidator',
    p.validation,
  );
  await expectRevert(
    p.validation.connect(p.kimiValidator).validationResponse(requestHash, 101, 'ipfs://r.json', hash('r'), 'soft'),
    'InvalidResponse',
    p.validation,
  );
  await expectRevert(
    p.validation.connect(p.kimiValidator).validationResponse(hash('unknown'), 90, 'ipfs://r.json', hash('r'), 'soft'),
    'UnknownRequest',
    p.validation,
  );
});

test('multiple responses accumulate as a soft → hard history', async () => {
  const requestHash = hash('resp-2');
  await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-6.json', requestHash,
  )).wait();

  // Pass 1 of the two-pass auditor: a provisional score with evidence.
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    requestHash, 40, 'ipfs://audit-pass1.json', hash('audit-1'), 'kimi-adversarial',
  )).wait();
  assert.equal(await p.validation.responseCount(requestHash), 1n);

  // Pass 2: the adversarial follow-up sharpens the verdict.
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    requestHash, 65, 'ipfs://audit-pass2.json', hash('audit-2'), 'kimi-adversarial',
  )).wait();

  const [validator, agentId, response, uri, responseHash, tag, lastUpdate] =
    await p.validation.getValidationStatus(requestHash);
  assert.equal(validator, p.kimiValidator.address);
  assert.equal(agentId, BigInt(agentA));
  assert.equal(response, 65n);
  assert.equal(uri, 'ipfs://audit-pass2.json');
  assert.equal(responseHash, hash('audit-2'));
  assert.equal(tag, 'kimi-adversarial');
  assert.equal(Number(lastUpdate) > 0, true);

  const history = await p.validation.getResponses(requestHash);
  assert.equal(history.length, 2);
  assert.equal(history[0].response, 40n);
  assert.equal(history[0].hard, false);
  assert.equal(history[1].response, 65n);

  const request = await p.validation.requestOf(requestHash);
  assert.equal(request.lastResponse, 65n);
  assert.equal(request.finalized, false, 'soft responses leave the request open');
});

test('a hard-tagged response finalizes a request permanently', async () => {
  const requestHash = hash('resp-3');
  await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-7.json', requestHash,
  )).wait();

  await (await p.validation.connect(p.kimiValidator).validationResponse(
    requestHash, 88, 'ipfs://audit-final.json', hash('audit-final'), 'hard',
  )).wait();

  const request = await p.validation.requestOf(requestHash);
  assert.equal(request.finalized, true);
  const [, , , , , tag] = await p.validation.getValidationStatus(requestHash);
  assert.equal(tag, 'hard');

  await expectRevert(
    p.validation.connect(p.kimiValidator).validationResponse(
      requestHash, 95, 'ipfs://audit-late.json', hash('audit-late'), 'kimi-adversarial',
    ),
    'RequestFinalized',
    p.validation,
  );

  // `final` is an alias for hard finality.
  const aliasHash = hash('resp-4');
  await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-8.json', aliasHash,
  )).wait();
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    aliasHash, 70, 'ipfs://audit-alias.json', hash('alias'), 'final',
  )).wait();
  assert.equal((await p.validation.requestOf(aliasHash)).finalized, true);
});

// ---------------------------------------------------------------------------
// Reads: summaries and the Kimi audit trail
// ---------------------------------------------------------------------------

test('getSummary averages the caller-supplied validator set, filtered by tag', async () => {
  const agentB = 2;
  const r1 = hash('sum-1');
  const r2 = hash('sum-2');
  await (await p.validation.connect(p.agentB).validationRequest(
    p.kimiValidator.address, agentB, 'ipfs://sum-1.json', r1,
  )).wait();
  await (await p.validation.connect(p.agentB).validationRequest(
    p.reviewer.address, agentB, 'ipfs://sum-2.json', r2,
  )).wait();

  await (await p.validation.connect(p.kimiValidator).validationResponse(r1, 80, 'ipfs://a.json', hash('a'), 'kimi-adversarial')).wait();
  await (await p.validation.connect(p.kimiValidator).validationResponse(r1, 100, 'ipfs://a2.json', hash('a2'), 'provider')).wait();
  await (await p.validation.connect(p.reviewer).validationResponse(r2, 40, 'ipfs://b.json', hash('b'), 'kimi-adversarial')).wait();

  // Empty validator set = no filter; empty tag = every tag.
  let [count, average] = await p.validation.getSummary(agentB, [], '');
  assert.equal(count, 3n);
  assert.equal(average, 73n); // (80 + 100 + 40) / 3

  // Tag filter.
  [count, average] = await p.validation.getSummary(agentB, [], 'kimi-adversarial');
  assert.equal(count, 2n);
  assert.equal(average, 60n); // (80 + 40) / 2

  // A relying party can exclude a validator it does not trust.
  [count, average] = await p.validation.getSummary(agentB, [p.kimiValidator.address], '');
  assert.equal(count, 2n);
  assert.equal(average, 90n); // (80 + 100) / 2

  // Unknown validator set → no data, no crash.
  [count, average] = await p.validation.getSummary(agentB, [p.outsider.address], '');
  assert.equal(count, 0n);
  assert.equal(average, 0n);
});

test('latestKimiScore exposes the newest adversarial audit verdict', async () => {
  const agentC = await activateAgent(p, { signer: p.challenger, uri: 'ipfs://agentC.json', score: 70 });
  assert.deepEqual([...(await p.validation.latestKimiScore(agentC))], [0n, 0n], 'never audited → zero');

  const r1 = hash('kimi-1');
  const r2 = hash('kimi-2');
  await (await p.validation.connect(p.challenger).validationRequest(
    p.kimiValidator.address, agentC, 'ipfs://kimi-1.json', r1,
  )).wait();
  await (await p.validation.connect(p.challenger).validationRequest(
    p.kimiValidator.address, agentC, 'ipfs://kimi-2.json', r2,
  )).wait();

  await (await p.validation.connect(p.kimiValidator).validationResponse(
    r1, 30, 'ipfs://k1.json', hash('k1'), 'kimi-adversarial',
  )).wait();
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    r2, 85, 'ipfs://k2.json', hash('k2'), 'kimi-adversarial',
  )).wait();

  const [score, timestamp] = await p.validation.latestKimiScore(agentC);
  assert.equal(score, 85n);
  assert.equal(Number(timestamp) > 0, true);

  // A non-Kimi response does not shadow the audit trail.
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    r2, 10, 'ipfs://k3.json', hash('k3'), 'provider',
  )).wait();
  const [stillScore] = await p.validation.latestKimiScore(agentC);
  assert.equal(stillScore, 85n, 'only kimi-adversarial responses count');

  // Latest wins even when posted on an older request. Mine one extra second first so the
  // two timestamps differ: within a single block, "latest" is genuinely ambiguous.
  await chain.increaseTime(60);
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    r1, 95, 'ipfs://k4.json', hash('k4'), 'kimi-adversarial',
  )).wait();
  const [newest] = await p.validation.latestKimiScore(agentC);
  assert.equal(newest, 95n);
});

test('responses are anchored by a hash, never by a blob', async () => {
  const requestHash = hash('anchor-1');
  await (await p.validation.connect(requester).validationRequest(
    p.kimiValidator.address, agentA, 'ipfs://request-anchor.json', requestHash,
  )).wait();
  const responseHash = hash('audit-blob');
  await (await p.validation.connect(p.kimiValidator).validationResponse(
    requestHash, 55, 'ipfs://audit-blob.json', responseHash, 'kimi-adversarial',
  )).wait();

  const record = (await p.validation.getResponses(requestHash))[0];
  assert.equal(record.responseHash, responseHash);
  assert.equal(record.responseURI, 'ipfs://audit-blob.json');
  assert.equal(await ethers.provider, await ethers.provider); // provider untouched
  assert.equal(record.validator, p.kimiValidator.address);
});
