// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title MockERC1271Wallet — a contract wallet for tests (stands in for a Privy
///        passkey smart account: no ECDSA key, validation delegated to the account).
contract MockERC1271Wallet is IERC1271, EIP712 {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    address public controller;
    bytes32 public expectedDigest;

    constructor(address controller_) EIP712("MockSmartAccount", "1") {
        controller = controller_;
    }

    function setExpectedDigest(bytes32 digest) external {
        require(msg.sender == controller, "not controller");
        expectedDigest = digest;
    }

    function isValidSignature(bytes32 hash, bytes memory) external view returns (bytes4) {
        return hash == expectedDigest ? MAGICVALUE : bytes4(0xffffffff);
    }

}
