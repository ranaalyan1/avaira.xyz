// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IAvairaComplianceGate} from "../interfaces/IAvairaComplianceGate.sol";

/// @title AvairaCVA — Cleanverse Verified Asset (CVI-gated ERC-20)
/// @notice A CVA whose every balance change is gated by the `AvairaComplianceGate`.
///
///         The coupling is in `_update`, the single chokepoint every ERC-20 mint,
///         transfer, transferFrom, burn and any future extension must pass through:
///         there is no transfer path — not `transfer`, not `transferFrom`, not an
///         operator allowance, not a mint — that skips identity verification. A wallet
///         without a valid, wallet-bound CVI credential cannot send *or* receive.
///
///         Reverts are the gate's own, so the failure reason is legible on-chain and in
///         the explorer: `CVI_MISSING`, `CVI_EXPIRED`, `CVI_REVOKED`.
contract AvairaCVA is ERC20, AccessControl {
    /* --------------------------------- events -------------------------------- */

    event ComplianceGateUpdated(address previousGate, address newGate);

    /* --------------------------------- errors -------------------------------- */

    error ZeroAddress();

    /* ---------------------------------- state --------------------------------- */

    /// @notice The CVI gate consulted on every balance change.
    IAvairaComplianceGate public complianceGate;
    /// @notice Role allowed to mint CVA (settlement legs, custody transfers).
    bytes32 public constant MINTER_ROLE = keccak256("AVAIRA_CVA_MINTER");

    /* ------------------------------- constructor ------------------------------ */

    /// @param complianceGate_ The `AvairaComplianceGate` every movement is checked against.
    /// @param admin Protocol admin (also granted `MINTER_ROLE`).
    constructor(address complianceGate_, address admin) ERC20("Avaira Cleanverse Verified Asset", "CVA") {
        if (complianceGate_ == address(0) || admin == address(0)) revert ZeroAddress();
        complianceGate = IAvairaComplianceGate(complianceGate_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        emit ComplianceGateUpdated(address(0), complianceGate_);
    }

    /* --------------------------------- minting -------------------------------- */

    /// @notice Mints `amount` CVA to `to`; `to` must hold a valid CVI credential.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Burns `amount` CVA from `from`; `from` must hold a valid CVI credential.
    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }

    /* ------------------------- structural coupling hook ----------------------- */

    /// @dev The Travel Rule gate. Originator and beneficiary both verified for a transfer;
    ///      for mint/burn only the single non-zero side is checked (there is no
    ///      counterparty), which keeps supply operations gated without a special case.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            complianceGate.requireVerified(to);
        } else if (to == address(0)) {
            complianceGate.requireVerified(from);
        } else {
            complianceGate.gateCVATransfer(from, to, value);
        }
        super._update(from, to, value);
    }

    /* ---------------------------------- admin --------------------------------- */

    /// @notice Points the token at a new compliance gate (migration path).
    function setComplianceGate(address newGate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newGate == address(0)) revert ZeroAddress();
        emit ComplianceGateUpdated(address(complianceGate), newGate);
        complianceGate = IAvairaComplianceGate(newGate);
    }
}
