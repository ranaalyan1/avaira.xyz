"""Tests for the deployment gates: `tools/verify_monad.py` and the manifest merge.

These are the checks that are supposed to *fail loudly* when a deployment is
missing or broken, so their failure modes are the product. Each verdict the tool
can print is exercised here against a stub JSON-RPC node: the point is not that
the code runs, but that "undeployed", "wrong chain", "dead address" and "wiring
drift" are each distinguishable and each exit non-zero.

Stdlib + pytest only — no py-evm, no web3, no network, so this runs in the same
job as the backend tests.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
import sys  # noqa: E402

sys.path.insert(0, str(REPO_ROOT / "tools"))

import verify_monad  # noqa: E402  (tools/ is on sys.path)


# ── fixtures ────────────────────────────────────────────────────────────────────


def addr(i: int) -> str:
    return "0x" + f"{i:040x}"


CHAIN = 10143
IDENTITY, REPUTATION, VALIDATION, STAKE, VAULT, MARKET, USDC = (addr(i) for i in range(1, 8))

MANIFEST = {
    "chainId": CHAIN,
    "identityRegistry": IDENTITY,
    "reputationRegistry": REPUTATION,
    "validationRegistry": VALIDATION,
    "stakeRegistry": STAKE,
    "intentVault": VAULT,
    "creditMarket": MARKET,
    "settlementToken": USDC,
    "admin": "0x" + "a" * 40,
    "treasury": "0x" + "b" * 40,
    "registrationBond": 50_000_000_000_000_000,
    "minStake": 100_000_000,
    "minScore": 60,
    "challengeWindow": 86_400,
    "challengerBond": 5_000_000,
    "minGroundedPayment": 100_000,
}


def word_address(a: str) -> str:
    return "0x" + "0" * 24 + a[2:].lower()


def word_uint(n: int) -> str:
    return "0x" + f"{n:064x}"


def sel(signature: str) -> str:
    """The 4-byte selector the tool will actually send for this signature."""
    return verify_monad.SEL[signature]


def happy_calls() -> dict:
    """(address, 4-byte selector) → returned word, for a correctly-wired stack."""
    return {
        (USDC, sel("decimals()")): word_uint(6),
        (IDENTITY, sel("enforcer()")): word_address(STAKE),
        (IDENTITY, sel("registrationBond()")): word_uint(MANIFEST["registrationBond"]),
        (IDENTITY, sel("treasury()")): word_address(MANIFEST["treasury"]),
        (REPUTATION, sel("identityRegistry()")): word_address(IDENTITY),
        (REPUTATION, sel("stakeRegistry()")): word_address(STAKE),
        (REPUTATION, sel("settlementToken()")): word_address(USDC),
        (REPUTATION, sel("minGroundedPayment()")): word_uint(MANIFEST["minGroundedPayment"]),
        (VALIDATION, sel("identityRegistry()")): word_address(IDENTITY),
        (STAKE, sel("identityRegistry()")): word_address(IDENTITY),
        (STAKE, sel("stakeToken()")): word_address(USDC),
        (STAKE, sel("minStake()")): word_uint(MANIFEST["minStake"]),
        (STAKE, sel("minScore()")): word_uint(MANIFEST["minScore"]),
        (VAULT, sel("identityRegistry()")): word_address(IDENTITY),
        (VAULT, sel("stakeRegistry()")): word_address(STAKE),
        (VAULT, sel("stakeToken()")): word_address(USDC),
        (VAULT, sel("challengeWindow()")): word_uint(MANIFEST["challengeWindow"]),
        (VAULT, sel("challengerBond()")): word_uint(MANIFEST["challengerBond"]),
        (MARKET, sel("identityRegistry()")): word_address(IDENTITY),
        (MARKET, sel("stakeRegistry()")): word_address(STAKE),
        (MARKET, sel("asset()")): word_address(USDC),
    }


class _Node(BaseHTTPRequestHandler):
    """A stub Monad node: answers the three methods verify_monad.py uses."""

    chain_id = CHAIN
    code: dict = {}
    calls: dict = {}

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        method, params = req.get("method"), req.get("params") or []
        if method == "eth_chainId":
            result = hex(self.chain_id)
        elif method == "eth_getCode":
            result = self.code.get(params[0], "0x6000")
        elif method == "eth_call":
            key = (params[0]["to"], params[0]["data"])
            result = self.calls.get(key, "0x")
        else:
            result = None
        body = json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep pytest output clean
        pass


@pytest.fixture
def node():
    """Start a stub node; override `chain_id`, `code`, `calls` before running the tool."""
    code = {a: "0x6000" for a in (IDENTITY, REPUTATION, VALIDATION, STAKE, VAULT, MARKET, USDC)}
    handler = type("Node", (_Node,), {"chain_id": CHAIN, "code": code, "calls": happy_calls()})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", handler
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def manifest_file(tmp_path):
    path = tmp_path / "10143.json"
    path.write_text(json.dumps(MANIFEST))
    return path


def run(node_url: str, manifest: Path, capsys) -> tuple[int, str]:
    code = verify_monad.main(["--chain", str(CHAIN), "--rpc", node_url, "--manifest", str(manifest)])
    return code, capsys.readouterr().out


# ── the four failure modes that matter ──────────────────────────────────────────


def test_undeployed_is_loud_and_names_the_three_steps(tmp_path, capsys):
    """No manifest = nothing deployed. That must be unmissable, not a stack trace."""
    code, out = run("http://127.0.0.1:1", tmp_path / "missing.json", capsys)

    assert code == 1
    assert "NOT DEPLOYED" in out
    assert "faucet.monad.xyz" in out  # the human's next action
    assert "make deploy-monad" in out
    assert "make deploy-dry-run" in out  # the no-key alternative


def test_healthy_deployment_passes(node, manifest_file, capsys):
    node_url, _ = node
    code, out = run(node_url, manifest_file, capsys)

    assert code == 0, out
    assert "all 7 contracts live and correctly wired" in out


def test_wrong_chain_is_reported_as_a_chain_mismatch(node, manifest_file, capsys):
    """Addresses from another chain prove nothing — say so instead of 'no bytecode'."""
    node_url, handler = node
    handler.chain_id = 143

    code, out = run(node_url, manifest_file, capsys)

    assert code == 1
    assert "WRONG CHAIN" in out
    assert "chain 143" in out


def test_dead_address_fails_and_names_the_contract(node, manifest_file, capsys):
    """A never-deployed address is the most likely real failure: funds ran out mid-deploy."""
    node_url, handler = node
    handler.code[VAULT] = "0x"

    code, out = run(node_url, manifest_file, capsys)

    assert code == 1
    assert "AvairaIntentVault" in out
    assert "no bytecode at this address" in out
    assert "1 of 7 contracts are not verifiably live" in out


def test_wiring_drift_is_caught(node, manifest_file, capsys):
    """Bytecode present is not enough: the getter must point at the right sibling."""
    node_url, handler = node
    handler.calls[(VAULT, sel("stakeRegistry()"))] = word_address(MARKET)  # wrong sibling

    code, out = run(node_url, manifest_file, capsys)

    assert code == 1
    assert "stakeRegistry()" in out
    assert VAULT in out


def test_silent_revert_counts_as_a_problem(node, manifest_file, capsys):
    """A contract that reverts on everything still has bytecode; the getter catches it."""
    node_url, handler = node
    handler.calls.pop((MARKET, sel("asset()")))

    code, out = run(node_url, manifest_file, capsys)

    assert code == 1
    assert "asset() returned nothing" in out


def test_unreachable_node_is_not_reported_as_undeployed(manifest_file, capsys):
    """A network failure and a missing deployment need different fixes."""
    code, out = run("http://127.0.0.1:1", manifest_file, capsys)

    assert code == 1
    assert "UNREACHABLE" in out
    assert "network problem" in out


def test_report_is_valid_json_with_per_contract_detail(node, manifest_file, tmp_path, capsys):
    node_url, _ = node
    report = tmp_path / "report.json"
    verify_monad.main(
        ["--chain", str(CHAIN), "--rpc", node_url, "--manifest", str(manifest_file), "--json", str(report)]
    )

    data = json.loads(report.read_text())
    assert data["verdict"] == "PASS"
    assert data["chainId"] == CHAIN
    assert len(data["contracts"]) == 7
    vault = next(c for c in data["contracts"] if c["name"] == "AvairaIntentVault")
    assert vault["address"] == VAULT
    assert vault["getters"]["stakeRegistry()"] == STAKE


# ── the selector table has to stay honest ───────────────────────────────────────


def test_selectors_are_four_byte_constants():
    for sig, selector in verify_monad.SEL.items():
        assert selector.startswith("0x") and len(selector) == 10, f"{sig} → {selector}"


def test_every_selector_used_by_build_checks_exists():
    """Guards the failure mode where a new check is added without its selector."""
    used = {sig for _, _, getters in verify_monad.build_checks(MANIFEST) for sig in getters}
    missing = sorted(used - set(verify_monad.SEL))
    assert not missing, f"no selector for {missing}"


def test_expectation_set_is_the_full_stack():
    names = [name for name, _, _ in verify_monad.build_checks(MANIFEST)]
    assert names == [
        "MockUSDC",
        "AvairaIdentityRegistry",
        "AvairaReputationRegistry",
        "AvairaValidationRegistry",
        "AvairaStakeRegistry",
        "AvairaIntentVault",
        "AvairaCreditMarket",
    ]


# ── manifest tx-hash merge ──────────────────────────────────────────────────────

import merge_deploy_txs  # noqa: E402  (tools/ is on sys.path)


def broadcast_fixture(chain: int = CHAIN) -> dict:
    """forge's run-latest.json shape: CREATE entries plus the wiring CALLs."""
    deployer = "0x" + "d" * 40
    tx = {
        "hash": "0x" + "1" * 64,
        "transactionType": "CREATE",
        "contractName": "AvairaIdentityRegistry",
        "contractAddress": IDENTITY,
        "transaction": {"from": deployer, "to": None},
        "additionalContracts": [],
    }
    return {
        "chain": chain,
        "transactions": [
            tx,
            {
                "hash": "0x" + "2" * 64,
                "transactionType": "CREATE",
                "contractName": "AvairaIntentVault",
                "contractAddress": VAULT,
                "transaction": {"from": deployer},
                "additionalContracts": [],
            },
            # wiring is a CALL and carries no contract identity — it must be skipped
            {
                "hash": "0x" + "3" * 64,
                "transactionType": "CALL",
                "contractName": None,
                "contractAddress": None,
                "transaction": {"from": deployer},
            },
        ],
    }


def test_merge_attaches_hashes_only_to_matching_addresses():
    manifest = dict(MANIFEST)
    merged, missing, mismatched = merge_deploy_txs.merge(manifest, merge_deploy_txs.collect_creates(broadcast_fixture()))

    assert not mismatched
    assert merged["deploymentTxs"] == {
        "AvairaIdentityRegistry": "0x" + "1" * 64,
        "AvairaIntentVault": "0x" + "2" * 64,
    }
    assert merged["deployer"] == "0x" + "d" * 40
    # everything the broadcast does not cover is named rather than silently absent
    assert "AvairaStakeRegistry" in missing
    assert "MockUSDC" in missing


def test_merge_refuses_a_hash_for_the_wrong_address():
    """A hash that points at a different address must never be attached."""
    broadcast = broadcast_fixture()
    broadcast["transactions"][0]["contractAddress"] = MARKET  # identity registry hash, market address

    _, _, mismatched = merge_deploy_txs.merge(dict(MANIFEST), merge_deploy_txs.collect_creates(broadcast))

    assert len(mismatched) == 1
    assert "AvairaIdentityRegistry" in mismatched[0]


def test_merge_is_additive_and_idempotent():
    manifest = dict(MANIFEST)
    creates = merge_deploy_txs.collect_creates(broadcast_fixture())
    once, _, _ = merge_deploy_txs.merge(manifest, creates)
    twice, _, _ = merge_deploy_txs.merge(dict(once), creates)

    assert once["deploymentTxs"] == twice["deploymentTxs"]
    # the SDK's own keys survive untouched
    for key in ("chainId", "identityRegistry", "intentVault", "settlementToken", "minScore"):
        assert twice[key] == MANIFEST[key]


def test_merge_cli_writes_the_manifest_and_check_agrees(tmp_path, capsys):
    manifest_path = tmp_path / "10143.json"
    manifest_path.write_text(json.dumps(MANIFEST))
    broadcast_path = tmp_path / "run-latest.json"
    broadcast_path.write_text(json.dumps(broadcast_fixture()))

    code = merge_deploy_txs.main(
        ["--chain", str(CHAIN), "--manifest", str(manifest_path), "--broadcast", str(broadcast_path)]
    )
    assert code == 0
    assert "merged 2/7" in capsys.readouterr().out

    written = json.loads(manifest_path.read_text())
    assert written["deploymentTxs"]["AvairaIntentVault"] == "0x" + "2" * 64

    # --check reports the same partial coverage without writing
    checked = merge_deploy_txs.main(
        ["--chain", str(CHAIN), "--manifest", str(manifest_path), "--broadcast", str(broadcast_path), "--check"]
    )
    assert checked == 1  # 2/7 is not full coverage, and --check says so
    assert "2/7 contracts carry a deploy tx hash" in capsys.readouterr().out


def test_merge_cli_without_a_broadcast_record_explains_why(tmp_path, capsys):
    manifest_path = tmp_path / "10143.json"
    manifest_path.write_text(json.dumps(MANIFEST))

    code = merge_deploy_txs.main(
        ["--chain", str(CHAIN), "--manifest", str(manifest_path), "--broadcast", str(tmp_path / "nope.json")]
    )

    assert code == 1


# ── the README's deployed-contracts section ─────────────────────────────────────

import gen_deploy_section  # noqa: E402  (tools/ is on sys.path)


def test_not_deployed_section_publishes_no_address_and_gives_the_three_steps():
    """The whole point: while undeployed, no address-shaped string can appear."""
    section = gen_deploy_section.render(CHAIN, None)

    assert section.startswith(gen_deploy_section.BEGIN), "BEGIN marker must be inside the rendered block"
    assert section.rstrip().endswith(gen_deploy_section.END)
    assert "Not deployed yet" in section
    for step in ("faucet.monad.xyz", "DEPLOYER_PRIVATE_KEY", "make deploy-monad"):
        assert step in section
    assert "make deploy-dry-run" in section  # the no-key alternative
    # no placeholder addresses either — a zero address is as misleading as a wrong one
    assert "0x0000000000000000000000000000000000000000" not in section
    assert not re.search(r"0x[0-9a-fA-F]{40}", section), "an address leaked into the undeployed section"


def test_deployed_section_links_every_address_and_tx():
    manifest = dict(MANIFEST)
    manifest["deploymentTxs"] = {
        "AvairaIdentityRegistry": "0x" + "1" * 64,
        "AvairaIntentVault": "0x" + "2" * 64,
    }
    manifest["deployer"] = "0x" + "d" * 40
    manifest["deploymentBlock"] = 12_345_678

    section = gen_deploy_section.render(CHAIN, manifest)

    assert "Monad Testnet" in section and "10143" in section
    for key, name, _ in gen_deploy_section.CONTRACTS:
        assert manifest[key] in section, f"{name} address is missing from the table"
        assert f"/address/{manifest[key]}" in section, f"{name} has no explorer link"
    assert "/tx/0x" + "1" * 64 in section
    # 2 of 7 tx hashes is partial coverage and must say so rather than imply completeness
    assert "2/7" in section


def test_splice_requires_both_markers():
    with pytest.raises(SystemExit):
        gen_deploy_section.splice("no markers here", "section")


def test_splice_is_reversible_and_keeps_surrounding_text():
    original = f"before\n{gen_deploy_section.BEGIN}\nstale\n{gen_deploy_section.END}\nafter\n"
    fresh = gen_deploy_section.render(CHAIN, None)

    updated = gen_deploy_section.splice(original, fresh)

    assert updated.startswith("before")
    assert updated.rstrip().endswith("after")
    assert "stale" not in updated
    # re-splicing the same section is a no-op — this is what --check relies on
    assert gen_deploy_section.splice(updated, fresh) == updated


# --- specs generator: a degraded interpreter must not certify the specs ---------------

def test_specs_check_refuses_to_certify_without_keccak(monkeypatch, capsys):
    """Without eth_utils every selector renders as an em-dash.

    Before this guard, `--check` compared those dashes against committed dashes and
    reported "specs fresh" — which is how 8 specs with no selectors were once committed.
    """
    import tools.gen_contract_specs as specs

    monkeypatch.setattr(specs, "_KECCAK", False, raising=False)
    assert specs.keccak4("BPS()") == "—", "fixture must simulate the missing backend"

    monkeypatch.setattr(sys, "argv", ["gen_contract_specs.py", "--check"])
    rc = specs.main()

    assert rc != 0, "a run that cannot compute selectors must not exit 0"
    assert "cannot verify specs" in capsys.readouterr().err


def test_specs_check_accepts_a_real_backend():
    """The guard must not fire when keccak is available and the specs are current."""
    import tools.gen_contract_specs as specs

    if specs.keccak4("BPS()") == "—":
        pytest.skip("eth_utils unavailable in this interpreter")
    assert specs.keccak4("BPS()") == "0x249d39e9"  # independently recomputed keccak
