// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";

/// @title HandoverAdmin
/// @notice Moves every admin surface of a fresh Avaira deployment from the deployer
///         to the final protocol admin, then renounces the deployer's roles.
///
///         `Deploy.s.sol` must run with ADMIN = the deployer, because every
///         cross-contract wiring call is admin-gated and reverts otherwise (the
///         constructors grant admin to ADMIN, not to the broadcaster). This script
///         is phase two: it hands over Ownership of the ERC-8004 identity registry
///         plus DEFAULT_ADMIN and the operational roles (scorer, slasher, validator
///         admin) on the AccessControl contracts to NEW_ADMIN, then renounces
///         everything the deployer held. Afterwards the deployer controls nothing.
///
/// Usage:
///   forge script script/HandoverAdmin.s.sol:HandoverAdmin \
///     --rpc-url $RPC --broadcast --slow \
///     --private-key $DEPLOYER_PRIVATE_KEY
///
/// Environment:
///   NEW_ADMIN             — final admin (required)
///   AVAIRA_DEPLOYMENT     — path to deployments/{chainId}.json (default: the standard path)
contract HandoverAdmin is Script {
    bytes32 public constant SCORER_ROLE = keccak256("AVAIRA_SCORER_ROLE");
    bytes32 public constant SLASHER_ROLE = keccak256("AVAIRA_SLASHER_ROLE");
    bytes32 public constant VALIDATOR_ADMIN_ROLE = keccak256("AVAIRA_VALIDATOR_ADMIN_ROLE");

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address newAdmin = vm.envAddress("NEW_ADMIN");

        uint256 chainId = block.chainid;
        string memory manifestPath = vm.envOr("AVAIRA_DEPLOYMENT", string(""));
        if (bytes(manifestPath).length == 0) {
            manifestPath = string.concat("deployments/", vm.toString(chainId), ".json");
        }

        string memory manifest = vm.readFile(manifestPath);
        address identity = vm.parseJsonAddress(manifest, ".identityRegistry");
        address reputation = vm.parseJsonAddress(manifest, ".reputationRegistry");
        address validation = vm.parseJsonAddress(manifest, ".validationRegistry");
        address stake = vm.parseJsonAddress(manifest, ".stakeRegistry");
        address vault = vm.parseJsonAddress(manifest, ".intentVault");
        address market = vm.parseJsonAddress(manifest, ".creditMarket");

        require(newAdmin != address(0), "NEW_ADMIN zero");
        require(newAdmin != deployer, "NEW_ADMIN == deployer");

        vm.startBroadcast(deployerKey);

        // 1. Ownable2Step: the ERC-8004 identity registry queues the transfer;
        //    the final admin accepts with acceptOwnership() from their wallet
        //    (one call). The deployer stays owner() until then, by design of
        //    the two-step pattern — it does NOT renounce, so nothing is lost.
        AvairaIdentityRegistry(identity).transferOwnership(newAdmin);

        // 2. AccessControl contracts: grant everything first, then renounce, so the
        //    deployer never loses the right to finish the handover mid-way.
        _grantAll(reputation, newAdmin, SCORER_ROLE);
        _grantAll(stake, newAdmin, SLASHER_ROLE);
        _grantAll(validation, newAdmin, VALIDATOR_ADMIN_ROLE);
        _grantAll(vault, newAdmin, bytes32(0));
        _grantAll(market, newAdmin, bytes32(0));

        _renounceAll(reputation, deployer, SCORER_ROLE);
        _renounceAll(stake, deployer, SLASHER_ROLE);
        _renounceAll(validation, deployer, VALIDATOR_ADMIN_ROLE);
        _renounceAll(vault, deployer, bytes32(0));
        _renounceAll(market, deployer, bytes32(0));

        // 3. Prove the handover: the deployer holds no AccessControl surface, and
        //    ownership of the identity registry is queued to the final admin.
        require(AvairaIdentityRegistry(identity).pendingOwner() == newAdmin, "pending owner != new admin");
        _requireHoldsNothing(reputation, deployer, SCORER_ROLE);
        _requireHoldsNothing(stake, deployer, SLASHER_ROLE);
        _requireHoldsNothing(validation, deployer, VALIDATOR_ADMIN_ROLE);
        _requireHoldsNothing(vault, deployer, bytes32(0));
        _requireHoldsNothing(market, deployer, bytes32(0));

        vm.stopBroadcast();

        console2.log("AccessControl handover complete. final admin:", newAdmin);
        console2.log("identity registry ownership queued to (accept from wallet):", newAdmin);
        console2.log("deployer renounced on all contracts:", deployer);
    }

    /// @dev Grants DEFAULT_ADMIN (role 0) plus `extraRole` to `newAdmin` on `target`.
    function _grantAll(address target, address newAdmin, bytes32 extraRole) internal {
        IAccessControl(target).grantRole(bytes32(0), newAdmin);
        if (extraRole != bytes32(0)) {
            IAccessControl(target).grantRole(extraRole, newAdmin);
        }
    }

    /// @dev Renounces DEFAULT_ADMIN (role 0) plus `extraRole` from `deployer` on `target`.
    ///      OZ's renounceRole must be called by the account itself — it is, we broadcast.
    function _renounceAll(address target, address deployer, bytes32 extraRole) internal {
        IAccessControl(target).renounceRole(bytes32(0), deployer);
        if (extraRole != bytes32(0)) {
            IAccessControl(target).renounceRole(extraRole, deployer);
        }
    }

    function _requireHoldsNothing(address target, address deployer, bytes32 extraRole) internal view {
        bytes32 adminRole = bytes32(0); // AccessControl.DEFAULT_ADMIN_ROLE
        require(!IAccessControl(target).hasRole(adminRole, deployer), "deployer still admin");
        if (extraRole != bytes32(0)) {
            require(!IAccessControl(target).hasRole(extraRole, deployer), "deployer still holds operational role");
        }
    }
}
