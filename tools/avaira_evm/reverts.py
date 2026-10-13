"""Revert-payload decoding shared by the harness, the SDK error pass and the doctor.

Two jobs:

* turn py-evm / eth-tester's `execution reverted: b'…'` message back into the raw revert
  bytes, and
* name those bytes: either a protocol custom error (`InsufficientStake(uint256,uint256)`)
  with its decoded arguments, or a Solidity `Panic`, which always means "an arithmetic or
  assertion check blew up" and is never a legitimate outcome.

The `Panic` codes are the ones the Solidity 0.8.x ABI defines; `INV-PANIC-01` treats any of
them appearing in a user-reachable path as a finding, because that is exactly what an
unchecked `-=`, a division by zero, or a cast that no longer fits looks like on-chain.
"""

from __future__ import annotations

import ast
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
CATALOG = os.path.join(REPO_ROOT, "build", "avaira", "error-catalog.json")

PANIC_CODES = {
    0x01: "assertion failed / compiler-invariant violated",
    0x11: "arithmetic underflow or overflow",
    0x12: "division or modulo by zero",
    0x21: "enum value out of range",
    0x22: "storage byte array out of bounds",
    0x31: "pop on an empty storage array",
    0x41: "too much memory allocated",
    0x51: "function called via an external call to zero, or bad function type",
    0x52: "literal string converted to a wrong-sized bytesN",
}

PANIC_SELECTOR = "4e487b71"
ERROR_SELECTOR = "08c379a0"  # Error(string)


def raw_revert_bytes(message: str) -> bytes:
    """Pull `b'…'` out of an eth-tester/web3 revert message, if the provider exposed one."""
    match = re.search(r"execution reverted:\s*b(['\"])(.*?)\1", message, re.S)
    if match:
        try:
            literal = f"b{match.group(1)}{match.group(2)}{match.group(1)}"
            return bytes(ast.literal_eval(literal))
        except Exception:  # noqa: BLE001 - malformed provider output should never crash a campaign
            return b""
    match = re.search(r"execution reverted:\s*(0x[0-9a-fA-F]+)", message)
    if match:
        return bytes.fromhex(match.group(1)[2:])
    return b""


class Catalog:
    """selector -> {signature, inputs, contract, file, line}, generated from the build ABI set."""

    def __init__(self, by_selector: dict[str, dict]):
        self.by_selector = by_selector

    @classmethod
    def load(cls, path: str = CATALOG) -> "Catalog":
        if not os.path.exists(path):
            return cls({})
        with open(path) as fh:
            return cls(json.load(fh))

    def describe(self, data: bytes) -> str:
        if len(data) < 4:
            return "reverted without data (bare REVERT)"
        selector = data[:4].hex()
        if selector == PANIC_SELECTOR:
            code = int.from_bytes(data[4:36], "big") if len(data) >= 36 else -1
            return f"Panic(0x{code:02x}) — {PANIC_CODES.get(code, 'unknown panic code')}"
        entry = self.by_selector.get(selector)
        if entry is None:
            return f"unknown selector 0x{selector}"
        name = f"{entry['name']}({','.join(i['type'] for i in entry.get('inputs', []))})"
        args = decode_args(data[4:], [i["type"] for i in entry.get("inputs", [])])
        return f"{name}{args}  [{entry.get('contract', '?')}] {entry.get('file', '')}:{entry.get('line', '')}"

    @staticmethod
    def is_panic(description: str) -> bool:
        return description.startswith("Panic(")

    @staticmethod
    def is_bare(description: str) -> bool:
        return description.startswith("reverted without data")


def decode_args(payload: bytes, types: list[str]) -> str:
    if not types:
        return "()"
    try:
        from eth_abi import decode

        values = decode(types, payload)
    except Exception:  # noqa: BLE001 - truncated/odd payloads are still worth reporting
        return f"(0x{payload.hex()})"
    out = []
    for value in values:
        if isinstance(value, bytes):
            out.append("0x" + value.hex()[:18] + ("…" if len(value) > 9 else ""))
        else:
            out.append(str(value))
    return "(" + ", ".join(out) + ")"
