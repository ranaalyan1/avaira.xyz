#!/usr/bin/env node
/**
 * solc-js compile harness for the Avaira Foundry sources.
 *
 * The repository is a standard Foundry project (`forge test` is the primary path and
 * is what CI runs). This harness exists so the same sources can be compiled and
 * executed in environments where the `forge`/`solc` native binaries are unavailable
 * (locked-down CI images, reviewer sandboxes) and so the deploy scripts share one
 * artifact pipeline with the tests.
 *
 * Usage:
 *   node lib/compile.js            # compile, print summary
 *   node lib/compile.js --json     # machine-readable summary on stdout
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const solc = require('solc');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'out-js');

const REMAPPINGS = [
  { prefix: 'forge-std/', target: path.join(ROOT, 'lib', 'forge-std', 'src') + '/' },
  { prefix: '@openzeppelin/contracts/', target: path.join(ROOT, 'lib', 'openzeppelin-contracts', 'contracts') + '/' },
];

function collectSolidityFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSolidityFiles(full, acc);
    else if (entry.name.endsWith('.sol')) acc.push(full);
  }
  return acc;
}

function sourceKey(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  for (const { prefix, target } of REMAPPINGS) {
    const targetRel = path.relative(ROOT, target).split(path.sep).join('/');
    if (rel.startsWith(targetRel + '/')) return prefix + rel.slice(targetRel.length + 1);
  }
  return rel;
}

const CACHE_FILE = path.join(OUT, '.cache.json');

function fingerprint(files, input) {
  const h = crypto.createHash('sha256');
  for (const file of files.sort()) h.update(file).update(fs.readFileSync(file));
  h.update(JSON.stringify(input.settings));
  h.update(solc.version());
  return h.digest('hex');
}

function loadCache(fingerprintValue) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw.fingerprint !== fingerprintValue) return null;
    const artifacts = {};
    for (const [name, artifact] of Object.entries(raw.artifacts)) artifacts[name] = artifact;
    if (Object.keys(artifacts).length === 0) return null;
    return { artifacts, warnings: [], errors: [] };
  } catch {
    return null;
  }
}

function writeCache(fingerprintValue, artifacts) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint: fingerprintValue, artifacts }));
}

function compile({ quiet = false, cache = true } = {}) {
  const files = collectSolidityFiles(SRC);
  const sources = {};
  for (const file of files) sources[sourceKey(file)] = { content: fs.readFileSync(file, 'utf8') };

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      viaIR: true,
      metadata: { bytecodeHash: 'none' },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata', 'storageLayout'] },
      },
    },
  };

  const findImport = (importPath) => {
    for (const { prefix, target } of REMAPPINGS) {
      if (importPath.startsWith(prefix)) {
        const resolved = path.join(target, importPath.slice(prefix.length));
        if (fs.existsSync(resolved)) return { contents: fs.readFileSync(resolved, 'utf8') };
      }
    }
    const direct = path.join(ROOT, importPath);
    if (fs.existsSync(direct)) return { contents: fs.readFileSync(direct, 'utf8') };
    return { error: `not found: ${importPath}` };
  };

  if (cache) {
    const fp = fingerprint(files, input);
    const cached = loadCache(fp);
    if (cached) {
      if (!quiet) console.log(`solc ${solc.version()} — cache hit, ${Object.keys(cached.artifacts).length} artifacts`);
      return cached;
    }
    return compileAndStore(input, findImport, files, fp, quiet);
  }
  return compileAndStore(input, findImport, files, null, quiet);
}

function compileAndStore(input, findImport, files, fp, quiet) {
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  const warnings = (output.errors || []).filter((e) => e.severity === 'warning');
  if (errors.length > 0) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error(`${errors.length} Solidity compile error(s)`);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const artifacts = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, artifact] of Object.entries(contracts)) {
      const record = {
        contractName: name,
        sourceName: file,
        abi: artifact.abi,
        bytecode: '0x' + artifact.evm.bytecode.object,
        deployedBytecode: '0x' + artifact.evm.deployedBytecode.object,
        metadata: artifact.metadata,
      };
      artifacts[name] = record;
      if (record.bytecode !== '0x' && artifact.evm.bytecode.object) {
        fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(record, null, 2));
      }
    }
  }

  if (fp) writeCache(fp, artifacts);

  if (!quiet) {
    const deployed = Object.values(artifacts).filter((a) => a.bytecode !== '0x');
    console.log(`solc ${solc.version()} — compiled ${files.length} source files, ${deployed.length} deployable contracts`);
    for (const w of warnings.slice(0, 12)) console.log(w.formattedMessage.trim().split('\n')[0]);
    if (warnings.length > 12) console.log(`... ${warnings.length - 12} more warnings`);
  }
  return { artifacts, warnings, errors };
}

module.exports = { compile, ROOT, OUT, sourceKey };

if (require.main === module) {
  const { artifacts } = compile();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.keys(artifacts).sort(), null, 2));
  }
}
