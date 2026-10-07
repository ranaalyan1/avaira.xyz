"""Avaira in-process EVM harness.

Why this exists
---------------
The contracts have to be provable on a machine with no Foundry, no Docker and no RPC
endpoint. This module runs the *real compiled bytecode* of all six Avaira contracts inside
py-evm, driven through `web3.py` — the exact stack `sdk/python` already depends on. One
harness therefore proves three things at once:

1. the contracts compile and deploy with the wiring that ships (`script/Deploy.s.sol`);
2. the protocol invariants hold under adversarial, seeded, reproducible call sequences;
3. the Python SDK's declared dependencies are sufficient to drive the protocol (Priority 1's
   install proof piggy-backs on this file).

Everything is deterministic: pinned fork (Cancun, matching `foundry.toml`), fixed funded
accounts, `gasPrice = 1` so gas costs are trivial to reason about, and explicit
`advance_time` instead of wall-clock reads. Nothing here touches the network.

Error handling is deliberately *not* exception-first: a stateful fuzzer needs to be able to
tell "reverted with custom error X" apart from "reverted for an unexpected reason" without
unwinding, so `transact()` returns a structured `TxResult`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
BUILD_DIR = os.environ.get("AVAIRA_BUILD_DIR", os.path.join(REPO_ROOT, "build", "avaira"))

GAS_PRICE = 2 * 10**9  # wei — above the Cancun base fee so every tx is fundable.
GAS_CEILING = 9_000_000

# Deployment parameters, copied from the defaults in contracts/script/Deploy.s.sol so that
# what we verify is what a real deployer would get.
DEFAULTS = {
    "registration_bond": 5 * 10**16,  # 0.05 ether
    "min_stake": 100 * 10**6,  # 100 USDC (6 decimals)
    "min_score": 60,
    "challenge_window": 24 * 3600,
    "challenger_bond": 5 * 10**6,  # 5 USDC
    "min_grounded_payment": 10**5,  # 0.1 USDC
    "seed_liquidity": 500_000 * 10**6,
    "mint_per_account": 10**12,  # 1,000,000 USDC each
}

STACK = [
    "MockUSDC",
    "AvairaIdentityRegistry",
    "AvairaReputationRegistry",
    "AvairaValidationRegistry",
    "AvairaStakeRegistry",
    "AvairaIntentVault",
    "AvairaCreditMarket",
]


class HarnessError(RuntimeError):
    pass


def load_artifacts(build_dir: str = BUILD_DIR) -> dict:
    path = os.path.join(build_dir, "artifacts.json")
    if not os.path.exists(path):
        raise HarnessError(
            f"missing {path}\n"
            "build it first with:\n"
            f"  npm --prefix {os.path.join(REPO_ROOT, 'tools')} ci && node {os.path.join(REPO_ROOT, 'tools', 'compile.mjs')}"
        )
    with open(path) as fh:
        return json.load(fh)


def load_manifest(build_dir: str = BUILD_DIR) -> dict:
    with open(os.path.join(build_dir, "build-manifest.json")) as fh:
        return json.load(fh)


GENESIS_BALANCE = 10**26  # 100M ETH per harness account: campaigns never run dry.


def _make_tester():
    """Cancun-pinned py-evm tester with generous genesis balances and a stable base fee."""
    from eth_tester import EthereumTester, PyEVMBackend

    kwargs: dict = {}
    try:  # Pin Cancun to match contracts/foundry.toml `evm_version = "cancun"`.
        from eth.vm.forks.cancun import CancunVM

        kwargs["vm_configuration"] = ((0, CancunVM),)
    except Exception:  # pragma: no cover - py-evm layout drift
        pass
    try:
        from eth_tester.backends.pyevm.main import generate_genesis_state_for_keys, get_default_account_keys

        keys = get_default_account_keys()
        kwargs["genesis_state"] = generate_genesis_state_for_keys(
            account_keys=keys,
            overrides={
                addr: {"balance": GENESIS_BALANCE}
                for addr in (k.public_key.to_checksum_address() for k in keys)
            },
        )
    except Exception:  # pragma: no cover - eth-tester layout drift
        pass
    try:
        return EthereumTester(PyEVMBackend(**kwargs))
    except Exception:  # pragma: no cover - fall back to plain defaults
        return EthereumTester(PyEVMBackend())


@dataclass
class TxResult:
    ok: bool
    gas_used: int = 0
    error: str = ""  # decoded custom error / revert reason
    reason: str = ""  # raw revert string from the EVM
    panic: bool = False  # True when the payload was a Solidity Panic (never acceptable)
    logs: list = field(default_factory=list)
    address: str | None = None

    def __bool__(self) -> bool:  # `if chain.transact(...):` reads naturally
        return self.ok

    def __getitem__(self, key: str):  # dict-style access keeps older call sites honest
        return getattr(self, key)


_CATALOG: "Catalog | None" = None


def catalog() -> "Catalog":
    global _CATALOG
    if _CATALOG is None:
        from avaira_evm.reverts import Catalog

        _CATALOG = Catalog.load()
    return _CATALOG


@dataclass
class Contract:
    name: str
    address: str
    w3c: Any
    error_by_selector: dict = field(default_factory=dict)
    fn_sigs: dict = field(default_factory=dict)

    def decode(self, message: str) -> str:
        """Turn a py-evm revert string into the custom error the developer should read.

        Resolution order: the compiler-generated error catalog (which knows every protocol
        error, its argument types and its source line) first, then this contract's own ABI.
        """
        from avaira_evm.reverts import raw_revert_bytes

        data = raw_revert_bytes(message)
        if data:
            return catalog().describe(data)
        for selector, signature in self.error_by_selector.items():
            if selector in message:
                return signature
        return _first_line(message)


@dataclass
class AvairaChain:
    """A fully-wired Avaira deployment living in this process."""

    artifacts: dict = field(default_factory=dict)
    tester: Any = None
    w3: Any = None
    accounts: list = field(default_factory=list)
    deployed: dict = field(default_factory=dict)
    deployer: str = ""
    admin: str = ""
    treasury: str = ""
    extra_keys: list = field(default_factory=list)
    #: Explaining a revert costs one extra static call. Keep it on for small runs and PoCs,
    #: off for the throughput-bound campaign (violations are reported either way).
    explain_reverts: bool = True
    tx_count: int = 0
    revert_count: int = 0
    gas_used_total: int = 0

    # ------------------------------------------------------------------ lifecycle
    @classmethod
    def spawn(cls, accounts: int = 12, deploy: bool = True) -> "AvairaChain":
        from web3 import Web3
        from web3.providers.eth_tester import EthereumTesterProvider

        tester = _make_tester()
        w3 = Web3(EthereumTesterProvider(tester))
        funded = list(tester.get_accounts())
        keys = []
        for i in range(max(0, accounts - len(funded))):
            from eth_utils import keccak

            priv = keccak(b"avaira-harness-account-" + str(i).encode())
            addr = _addr_from_key(priv)
            tester.add_account("0x" + priv.hex())
            keys.append(addr)
            funded.append(addr)
        chain = cls(artifacts=load_artifacts(), tester=tester, w3=w3, accounts=funded[:accounts], extra_keys=keys)
        # Fund the generated accounts with ETH so they can sign; deterministic transfer.
        for addr in keys:
            must(chain._raw_tx(funded[0], addr, 10**18))
        chain.deployer = chain.admin = chain.accounts[0]
        chain.treasury = chain.accounts[1]
        if deploy:
            chain.deploy_stack()
        for attr in ("identity_addr", "stake_addr", "vault_addr", "market_addr", "reputation_addr", "validation_addr"):
            if deploy and not getattr(chain, attr, None):
                raise HarnessError(f"{attr} unset after deploy_stack")
        return chain

    def deploy_stack(self) -> None:
        d = DEFAULTS
        self.usdc_addr = self._deploy("MockUSDC", [])[0]
        self.identity_addr = self._deploy("AvairaIdentityRegistry", [d["registration_bond"], self.admin])[0]
        self.reputation_addr = self._deploy(
            "AvairaReputationRegistry", [self.identity_addr, zero_address(), self.usdc_addr, self.admin]
        )[0]
        self.validation_addr = self._deploy("AvairaValidationRegistry", [self.identity_addr, self.admin])[0]
        self.stake_addr = self._deploy(
            "AvairaStakeRegistry",
            [self.usdc_addr, self.identity_addr, self.reputation_addr, d["min_stake"], d["min_score"], self.admin],
        )[0]
        self.vault_addr = self._deploy(
            "AvairaIntentVault", [self.identity_addr, self.stake_addr, self.usdc_addr, d["challenge_window"], self.admin]
        )[0]
        self.market_addr = self._deploy(
            "AvairaCreditMarket", [self.usdc_addr, self.stake_addr, self.identity_addr, self.admin]
        )[0]

        # ---- cross-contract wiring, same calls as Deploy.s.sol -------------------------
        must(
            self.transact(
                "AvairaReputationRegistry", "setScorerConfig(address,address,uint256)", [self.stake_addr, self.usdc_addr, d["min_grounded_payment"]], self.admin
            )
        )
        must(
            self.transact(
                "AvairaIdentityRegistry",
                "setEnforcer(address)",
                [self.stake_addr],
                self.admin,
            )
        )
        must(self.transact("AvairaIdentityRegistry", "setTreasury(address)", [self.treasury], self.admin))
        # AV-010 guard, mirroring the assertion added to script/Deploy.s.sol: a stack whose
        # identity registry does not treat the stake registry as its enforcer cannot propagate
        # bans, so a harness built on it would be verifying the wrong protocol.
        if self.call("AvairaIdentityRegistry", "enforcer()").lower() != self.stake_addr.lower():
            raise HarnessError("identity registry enforcer is not the stake registry — wiring drift")
        must(self.transact("AvairaStakeRegistry", "setSlasher(address,bool)", [self.vault_addr, True], self.admin))
        must(self.transact("AvairaStakeRegistry", "setTreasury(address)", [self.treasury], self.admin))
        must(self.transact("AvairaIntentVault", "setChallengerBond(uint256)", [d["challenger_bond"]], self.admin))
        must(self.transact("AvairaIntentVault", "setTreasury(address)", [self.treasury], self.admin))

        # ---- faucet + seeded market liquidity (mock-only paths in the deploy script) ----
        for who in self.accounts:
            must(self.transact("MockUSDC", "mint(address,uint256)", [who, d["mint_per_account"]], self.admin))
        must(self.transact("MockUSDC", "approve(address,uint256)", [self.market_addr, d["seed_liquidity"]], self.admin))
        must(self.transact("AvairaCreditMarket", "fundLiquidity(uint256)", [d["seed_liquidity"]], self.admin))
        # Test-only read oracle (contracts/test/harness/AvairaProbe.sol); never deployed on a real chain.
        self._deploy("AvairaProbe", [self.stake_addr, self.vault_addr])

    # ------------------------------------------------------------------ primitives
    def _raw_tx(self, sender: str, to: str, value: int) -> TxResult:
        params = {
            "from": sender,
            "to": to,
            "value": value,
            "gas": GAS_CEILING,
            "gasPrice": GAS_PRICE,
            "nonce": self.w3.eth.get_transaction_count(sender),
        }
        try:
            tx_hash = self.w3.eth.send_transaction(params)
        except Exception as exc:  # noqa: BLE001
            return TxResult(ok=False, error=_first_line(exc))
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.tx_count += 1
        self.gas_used_total += int(receipt["gasUsed"])
        return TxResult(ok=receipt["status"] == 1, gas_used=int(receipt["gasUsed"]))
    def call(self, name: str, signature: str, args: list | None = None, sender: str | None = None):
        """Static call. Raises on revert — views are asserted, never guessed."""
        c = self.deployed[name]
        f = c.w3c.get_function_by_signature(signature)(*(args or []))
        tx = {"from": sender or self.admin}
        return f.call(tx)

    def try_call(self, name: str, signature: str, args: list | None = None, sender: str | None = None):
        try:
            return True, self.call(name, signature, args, sender)
        except Exception as exc:  # noqa: BLE001 - classified below
            return False, self.deployed[name].decode(str(exc))

    def transact(
        self,
        name: str,
        signature: str,
        args: list | None = None,
        sender: str = "",
        value: int = 0,
        explain: bool | None = None,
    ) -> TxResult:
        c = self.deployed[name]
        sender = sender or self.admin
        f = c.w3c.get_function_by_signature(signature)(*(args or []))
        params = {
            "from": sender,
            "gasPrice": GAS_PRICE,
            "gas": GAS_CEILING,
            "nonce": self.w3.eth.get_transaction_count(sender),
            "value": value,
        }
        try:
            tx_hash = f.transact(params)
        except Exception as exc:  # noqa: BLE001 - this is the classifier
            self.revert_count += 1
            described = c.decode(_first_line(exc))
            return TxResult(
                ok=False,
                gas_used=0,
                error=described,
                reason=_first_line(exc),
                panic=described.startswith("Panic("),
            )
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.tx_count += 1
        self.gas_used_total += int(receipt["gasUsed"])
        if receipt["status"] != 1:
            self.revert_count += 1
            # The transaction left no state behind, so replaying it as a static call
            # reproduces the exact revert and gives us the custom-error name for free.
            want_explain = self.explain_reverts if explain is None else explain
            detail = self.revert_reason(name, signature, args or [], sender) if want_explain else "reverted"
            described = c.decode(detail)
            return TxResult(
                ok=False,
                gas_used=int(receipt["gasUsed"]),
                error=described,
                reason=detail,
                panic=described.startswith("Panic("),
            )
        return TxResult(ok=True, gas_used=int(receipt["gasUsed"]), logs=list(receipt["logs"]), address=receipt.get("contractAddress"))

    def revert_reason(self, name: str, signature: str, args: list, sender: str) -> str:
        """Best-effort human-readable revert reason for a call that just failed."""
        c = self.deployed[name]
        try:
            c.w3c.get_function_by_signature(signature)(*args).call(
                {"from": sender, "gasPrice": GAS_PRICE, "gas": GAS_CEILING}
            )
        except Exception as exc:  # noqa: BLE001
            return _first_line(exc)
        return "reverted without data (no reason exposed by the EVM)"

    def deploy_extra(self, name: str, args: list, sender: str = "") -> TxResult:
        addr, _ = self._deploy(name, args, sender or self.admin, register=False)
        return TxResult(ok=True, address=addr)

    def _deploy(self, name: str, args: list, sender: str | None = None, register: bool = True):
        art = self.artifacts.get(name)
        if art is None:
            raise HarnessError(f"artifact `{name}` is not in build/avaira — add it to TARGETS in tools/compile.mjs")
        sender = sender or self.deployer
        c = self.w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"])
        params = {
            "from": sender,
            "gasPrice": GAS_PRICE,
            "gas": GAS_CEILING,
            "nonce": self.w3.eth.get_transaction_count(sender),
        }
        try:
            tx_hash = c.constructor(*args).transact(params)
        except Exception as exc:  # noqa: BLE001
            raise HarnessError(f"{name}: constructor reverted -> {_first_line(exc)}") from exc
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.tx_count += 1
        self.gas_used_total += int(receipt["gasUsed"])
        if receipt["status"] != 1:
            raise HarnessError(f"{name}: constructor reverted (status 0)")
        addr = receipt["contractAddress"]
        if register:
            self.deployed[name] = Contract(
                name=name,
                address=addr,
                w3c=self.w3.eth.contract(address=addr, abi=art["abi"]),
                error_by_selector=_error_selectors(art["abi"]),
            )
        return addr, receipt

    # ------------------------------------------------------------------ chain control
    def advance_time(self, seconds: int) -> int:
        target = self.tester.get_block_by_number("pending")["timestamp"] + seconds
        self.tester.time_travel(target)
        self.tester.mine_block()
        return target

    def now(self) -> int:
        return int(self.w3.eth.get_block("latest")["timestamp"])

    def mine(self, blocks: int = 1) -> None:
        self.tester.mine_blocks(blocks)

    def snapshot(self) -> tuple[int, int]:
        """World-state + clock checkpoint. Both are restored by `revert`."""
        return int(self.tester.take_snapshot()), self.now()

    def revert(self, pid_or_pair: tuple[int, int] | int) -> None:
        pid, at = pid_or_pair if isinstance(pid_or_pair, tuple) else (pid_or_pair, None)
        self.tester.revert_to_snapshot(pid)
        if at is not None and self.now() != at:
            # eth-tester snapshots do not always carry the clock; restore it explicitly so a
            # replayed sequence sees the same timestamps it saw the first time.
            self.tester.time_travel(at)
            self.tester.mine_block()

    def key_for(self, who: str):
        """Private key of a harness account. Test-only: these keys belong to throwaway accounts
        generated by eth-tester (or by `spawn`), never to a funded wallet."""
        for k in self.tester.backend.account_keys:
            if k.public_key.to_checksum_address().lower() == who.lower():
                return k
        from eth_utils import to_canonical_address

        raise HarnessError(f"no harness key for {who}")

    # ------------------------------------------------------------------ token helpers
    def token_balance(self, who: str) -> int:
        return self.deployed["MockUSDC"].w3c.functions.balanceOf(who).call()

    def eth_balance(self, who: str) -> int:
        return int(self.w3.eth.get_balance(who))


# --------------------------------------------------------------------- helpers
def _addr_from_key(priv: bytes) -> str:
    from eth_keys import keys

    return keys.PrivateKey(priv).public_key.to_checksum_address()


def zero_address() -> str:
    return "0x" + "00" * 20


def _first_line(exc: Exception) -> str:
    return str(exc).strip().split("\n")[0][:500]


def _error_selectors(abi: list) -> dict:
    from eth_utils import keccak, text_if_str, to_bytes

    out = {}
    for item in abi:
        if item.get("type") == "error":
            sig = item["name"] + "(" + ",".join(i["type"] for i in item.get("inputs", [])) + ")"
            sel = keccak(text=sig)[:4].hex()
            out[sel] = sig
    return out


def must(result: TxResult) -> TxResult:
    if not result.ok:
        raise HarnessError(f"setup transaction failed: {result.error}")
    return result
