#!/usr/bin/env node
/**
 * Deterministic, toolchain-free Solidity compiler.
 *
 * Why this exists: `forge build` needs the Foundry toolchain, which is not always
 * reachable (air-gapped CI runners, corporate laptops, this repo's own sandbox). The
 * proof harness in `tools/evm/` has to run *somewhere*, so it compiles through the
 * solc-js standard-JSON interface published on npm instead. Same compiler version as
 * contracts/foundry.toml (`solc_version = "0.8.37"`), same `evmVersion`, same optimizer
 * runs. `viaIR` is enabled when it fits in the WASM heap; the emitted `build-manifest.json`
 * records which profile was actually used, so nobody can mistake a `viaIR:false` build for
 * the deployed one.
 *
 * Usage:  node tools/compile.mjs [--out build/avaira]
 * Exit:   0 on success, 1 on any compile error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE_DIR, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'build/avaira');

/** Contracts whose bytecode the harness deploys. */
const TARGETS = [
  'src/core/AvairaIdentityRegistry.sol',
  'src/core/AvairaReputationRegistry.sol',
  'src/core/AvairaValidationRegistry.sol',
  'src/core/AvairaIntentVault.sol',
  'src/core/AvairaStakeRegistry.sol',
  'src/core/AvairaCreditMarket.sol',
  'src/tokens/MockUSDC.sol',
  'test/harness/AvairaProbe.sol',
];

const CACHE = new Map();
function readSource(p) {
  if (CACHE.has(p)) return CACHE.get(p);
  const src = fs.readFileSync(p, 'utf8');
  CACHE.set(p, src);
  return src;
}

/** Resolve an import to a source-unit key, mirroring contracts/remappings.txt. */
function resolveImport(importer, spec) {
  const remappings = [
    ['forge-std/', path.join(CONTRACTS, 'lib/forge-std/src/')],
    ['@openzeppelin/contracts/', path.join(CONTRACTS, 'node_modules/@openzeppelin/contracts/')],
    ['avaira/', path.join(CONTRACTS, 'src/')],
  ];
  for (const [from, to] of remappings) {
    if (spec.startsWith(from)) return path.join(to, spec.slice(from.length));
  }
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return path.isAbsolute(spec) ? spec : path.resolve(path.dirname(importer), spec);
  }
  // node_modules-style bare specifier
  return path.join(CONTRACTS, 'node_modules', spec);
}

function collect(entryPaths) {
  const sources = {};
  const seen = new Set();
  const queue = entryPaths.map((e) => path.resolve(CONTRACTS, e));
  while (queue.length) {
    const abs = queue.shift();
    const key = path.relative(CONTRACTS, abs).split(path.sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(abs)) {
      throw new Error(`missing source file for ${key} (run \`npm ci\` inside contracts/ to vendor @openzeppelin)`);
    }
    const src = readSource(abs);
    sources[key] = { content: src };
    for (const m of src.matchAll(/^\s*import\s+(?:[^\n]*?)["']([^"']+)["']/gm)) {
      queue.push(resolveImport(abs, m[1]));
    }
  }
  return sources;
}

const SOLC_DIR = path.join(HERE_DIR, 'node_modules/solc');

function build(input, label) {
  const solc = require(path.join(SOLC_DIR, 'index.js'));
  const out = solc.compile(JSON.stringify(input), {
    import: (find) => {
      const abs = find.startsWith('/')
        ? path.join(CONTRACTS, find.slice(1))
        : resolveImport(path.join(CONTRACTS, 'src/__resolver__.sol'), find);
      if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
      return { contents: readSource(abs) };
    },
  });
  const parsed = JSON.parse(out);
  const errors = (parsed.errors ?? []).filter((e) => e.severity === 'error');
  for (const e of errors) console.error(`[${label}] ${e.sourceLocation?.file ?? '?'}: ${e.formattedMessage.trim()}`);
  return { parsed, errors };
}

const sources = collect(TARGETS);
const common = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};

let usedViaIr = true;
let { parsed, errors } = build({ ...common, settings: { ...common.settings, viaIR: true } }, 'viaIR');
if (errors.length) {
  console.error(`\nviaIR profile failed (${errors.length} error(s)); retrying with viaIR:false`);
  usedViaIr = false;
  ({ parsed, errors } = build({ ...common, settings: { ...common.settings, viaIR: false } }, 'via-ir-off'));
}
if (errors.length) {
  console.error(`\nFATAL: both compile profiles failed. ${errors.length} error(s).`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const artifacts = {};
for (const [file, byName] of Object.entries(parsed.contracts ?? {})) {
  for (const [name, art] of Object.entries(byName)) {
    if (!art.evm?.bytecode?.object || name.includes('.')) continue;
    artifacts[name] = {
      contractName: name,
      source: file,
      abi: art.abi,
      bytecode: `0x${art.evm.bytecode.object}`,
      deployedBytecode: `0x${art.evm.deployedBytecode.object}`,
    };
    fs.mkdirSync(path.join(OUT, name), { recursive: true });
    fs.writeFileSync(path.join(OUT, name, 'abi.json'), JSON.stringify(art.abi, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, name, 'bytecode.json'), JSON.stringify(artifacts[name], null, 2) + '\n');
  }
}
/* ---------------------------------- catalogs ---------------------------------- */
/** selector -> error metadata, straight from the compiler's AST so line numbers are real. */
function keccakSelector(sig) {
  // `js-sha3` ships as a transitive dependency of solc-js, so this adds no new install step.
  try {
    const { keccak256 } = require('js-sha3');
    return keccak256.array(Buffer.from(sig, 'utf8')).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

const errorCatalog = {};
const errorLines = new Map(); // `${file}:${contract}` -> { errorName -> line }
for (const [file, src] of Object.entries(parsed.sources ?? {})) {
  if (!file.startsWith('src/')) continue;
  const text = CACHE.get(path.resolve(CONTRACTS, file)) ?? '';
  const perContract = new Map();
  for (const node of src.ast?.nodes ?? []) {
    const members = Array.isArray(node.nodes) ? node.nodes : [];
    for (const member of members) {
      if (!['ErrorDefinition', 'EventDefinition', 'FunctionDefinition'].includes(member.nodeType)) continue;
      const offset = Number(String(member.src ?? '0:0:0').split(':')[0]);
      if (!perContract.has(member.name)) perContract.set(member.name, lineOf(text, offset));
    }
  }
  errorLines.set(file, perContract);
}

for (const [name, art] of Object.entries(artifacts)) {
  if (!art.source.startsWith('src/')) continue; // protocol errors only: what a user can actually see
  const lines = errorLines.get(art.source) ?? new Map();
  for (const item of art.abi) {
    if (item.type !== 'error') continue;
    const types = (item.inputs ?? []).map((i) => i.type).join(',');
    const sig = `${item.name}(${types})`;
    const sel = keccakSelector(sig);
    if (!sel || errorCatalog[sel]) continue;
    errorCatalog[sel] = {
      name: item.name,
      signature: sig,
      contract: name,
      file: art.source,
      line: lines.get(item.name) ?? 0,
      inputs: (item.inputs ?? []).map((i) => ({ name: i.name, type: i.type })),
    };
  }
}

const manifest = {
  schema: 'avaira.build-manifest/v1',
  compiler: { name: 'solc-js', version: require(path.join(SOLC_DIR, 'package.json')).version },
  profiles: { viaIR: usedViaIr, optimizerRuns: 200, evmVersion: 'cancun' },
  matchesFoundryProfile: usedViaIr,
  sources: Object.keys(sources).sort(),
  errorCatalogSize: Object.keys(errorCatalog).length,
  artifacts: Object.keys(artifacts).sort().map((n) => ({
    name: n,
    source: artifacts[n].source,
    bytecodeLength: (artifacts[n].bytecode.length - 2) / 2,
    deployedBytecodeLength: (artifacts[n].deployedBytecode.length - 2) / 2,
  })),
};
fs.writeFileSync(path.join(OUT, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
fs.writeFileSync(path.join(OUT, 'error-catalog.json'), JSON.stringify(errorCatalog, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`compiled ${Object.keys(artifacts).length} artifacts -> ${path.relative(ROOT, OUT)} (viaIR=${usedViaIr}, solc ${manifest.compiler.version})`);
