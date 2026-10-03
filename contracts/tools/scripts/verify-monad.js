#!/usr/bin/env node
/**
 * Avaira verification — submits every deployed contract to the Monad explorer.
 *
 *   node tools/scripts/verify-monad.js --network monad-testnet
 *   node tools/scripts/verify-monad.js --network monad-testnet --dry-run
 *
 * The script reads the manifest written by deploy-monad.js, rebuilds the exact standard
 * JSON input that produced each artifact (same sources, same remappings, same compiler
 * settings), and submits it to the explorer's Etherscan-compatible verification API. It
 * waits for each job and prints the result, so the README can carry real explorer links
 * rather than intent.
 *
 * Environment:
 *   EXPLORER_API_URL   default https://api.etherscan.io/v2/api?chainid=10143 (Monad testnet)
 *   EXPLORER_API_KEY   required by most explorers; may be "Any" on some
 *
 * --dry-run writes one payload per contract under deployments/<network>-verify/ and never
 * touches the network, which is how this is tested in sandboxes without explorer access.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOYMENTS = path.resolve(ROOT, '..', 'deployments');
const SRC = path.join(ROOT, 'src');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const NETWORK = flag('network', 'monad-testnet');
const DRY_RUN = Boolean(flag('dry-run', false));
const API_URL = flag('api') || process.env.EXPLORER_API_URL || 'https://api.etherscan.io/v2/api?chainid=10143';
const API_KEY = process.env.EXPLORER_API_KEY || flag('key') || '';

const REMAPPINGS = [
  { prefix: 'forge-std/', target: path.join(ROOT, 'lib', 'forge-std', 'src') + '/' },
  { prefix: '@openzeppelin/contracts/', target: path.join(ROOT, 'lib', 'openzeppelin-contracts', 'contracts') + '/' },
];

/** Collect the same sources the compiler saw (see tools/lib/compile.js). */
function collectSources() {
  const sources = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sol')) {
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        let key = rel;
        for (const { prefix, target } of REMAPPINGS) {
          const targetRel = path.relative(ROOT, target).split(path.sep).join('/');
          if (rel.startsWith(targetRel + '/')) key = prefix + rel.slice(targetRel.length + 1);
        }
        sources[key] = { content: fs.readFileSync(full, 'utf8') };
      }
    }
  };
  walk(SRC);
  walk(path.join(ROOT, 'lib'));
  return sources;
}

/**
 * Compiler settings are read from the artifact's own metadata — the compiler wrote them,
 * so the verification input cannot drift from the bytecode that was deployed. Only the
 * output selection is ours (the explorer needs the ABI to match the constructor args).
 */
function settingsFromArtifact(contractName) {
  const artifactPath = path.join(ROOT, 'out-js', `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const metadata = JSON.parse(artifact.metadata);
  const { evmVersion, optimizer, libraries, remappings } = metadata.settings;
  return {
    optimizer,
    evmVersion,
    viaIR: true,
    ...(libraries && Object.keys(libraries).length ? { libraries } : {}),
    remappings: remappings ?? [],
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.json();
}

async function poll(url, guid) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(3000);
    const query = `${url}&module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`;
    const result = await (await fetch(query)).json();
    const text = String(result.result ?? '');
    if (/Pending/i.test(text)) continue;
    return text;
  }
  return 'Timed out waiting for the explorer';
}

async function main() {
  const manifestPath = path.join(DEPLOYMENTS, `${NETWORK}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`no manifest at ${manifestPath} — run tools/scripts/deploy-monad.js first`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.network !== NETWORK) {
    throw new Error(`manifest is for ${manifest.network}, not ${NETWORK}`);
  }

  const sources = collectSources();
  console.log(`# verifying ${manifest.contracts.length} contracts on ${NETWORK}`);
  console.log(`# sources: ${Object.keys(sources).length} files · api: ${DRY_RUN ? 'dry run' : API_URL}`);

  const outDir = path.join(DEPLOYMENTS, `${NETWORK}-verify`);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const contract of manifest.contracts) {
    const input = {
      language: 'Solidity',
      sources,
      settings: settingsFromArtifact(contract.contractName),
    };
    const payload = {
      apikey: API_KEY || '(dry run)',
      module: 'contract',
      action: 'verifysourcecode',
      contractaddress: contract.address,
      sourceCode: JSON.stringify(input),
      codeformat: 'solidity-standard-json-input',
      contractname: `${contract.sourceName ?? `src/${contract.contractName}.sol`}:${contract.contractName}`,
      compilerversion: `v${manifest.compiler.solc}`,
      constructorArguements: contract.constructorArgs ?? '',
    };

    fs.writeFileSync(
      path.join(outDir, `${contract.contractName}.json`),
      JSON.stringify({ payload: { ...payload, sourceCode: '<standard-json-input>' }, request: payload }, null, 2),
    );

    if (DRY_RUN) {
      console.log(`  ${contract.contractName.padEnd(26)} payload written (${String(payload.sourceCode).length} bytes)`);
      results.push({ contract: contract.contractName, address: contract.address, status: 'dry-run' });
      continue;
    }

    if (!API_KEY) throw new Error('EXPLORER_API_KEY is required to verify (or pass --dry-run)');
    const response = await postForm(API_URL, payload);
    if (response.status !== '1') {
      console.log(`  ${contract.contractName.padEnd(26)} FAILED: ${response.result ?? response.message}`);
      results.push({
        contract: contract.contractName, address: contract.address, status: 'failed', detail: response.result ?? response.message,
      });
      continue;
    }
    const outcome = await poll(API_URL, response.result);
    const ok = /Pass - Verified|Already Verified/i.test(outcome);
    console.log(`  ${contract.contractName.padEnd(26)} ${ok ? 'verified' : 'FAILED'} — ${outcome}`);
    results.push({ contract: contract.contractName, address: contract.address, status: ok ? 'verified' : 'failed', detail: outcome });
  }

  const reportPath = path.join(DEPLOYMENTS, `${NETWORK}-verification.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ network: NETWORK, checkedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${reportPath}`);
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
