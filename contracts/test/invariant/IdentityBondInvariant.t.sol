// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";

/// @notice Drives the registry through every bond-mutating path with adversarial inputs.
contract IdentityBondHandler is Test {
    AvairaIdentityRegistry public immutable registry;
    uint256 public constant BOND = 0.05 ether;

    address[] public actors;
    uint256[] public minted;
    uint256 public registrations;
    uint256 public exits;
    uint256 public bans;

    constructor(AvairaIdentityRegistry registry_) {
        registry = registry_;
        actors = [makeAddr("h-alice"), makeAddr("h-bob"), makeAddr("h-carol")];
        for (uint256 i; i < actors.length; ++i) {
            vm.deal(actors[i], 100 ether);
        }
    }

    function register(uint256 actorSeed, uint256 uriSeed) external {
        address actor = actors[actorSeed % actors.length];
        if (registry.bannedOperators(actor)) return;

        vm.prank(actor);
        try registry.register{value: BOND}(string.concat("ipfs://agent-", vm.toString(uriSeed % 1000))) returns (
            uint256 agentId
        ) {
            minted.push(agentId);
            registrations++;
        } catch {
            // bond/URI policy rejections are legitimate outcomes, not failures
        }
    }

    function exit(uint256 idSeed) external {
        if (minted.length == 0) return;
        uint256 agentId = minted[idSeed % minted.length];
        address owner = registry.ownerOf(agentId);

        vm.prank(owner);
        try registry.exitAgent(agentId) {
            exits++;
        } catch {}
    }

    function ban(uint256 idSeed, uint256 treasurySeed) external {
        if (minted.length == 0) return;
        uint256 agentId = minted[idSeed % minted.length];
        address treasury = actors[treasurySeed % actors.length];
        if (treasury == address(0)) return;
        if (registry.isBanned(agentId)) return;

        registry.setTreasury(treasury);
        try registry.banAgent(agentId, "invariant: forfeit") {
            bans++;
        } catch {}
    }

    function transfer(uint256 idSeed, uint256 toSeed) external {
        if (minted.length == 0) return;
        uint256 agentId = minted[idSeed % minted.length];
        address owner = registry.ownerOf(agentId);
        address to = actors[toSeed % actors.length];
        if (to == owner) return;

        vm.prank(owner);
        try registry.transferFrom(owner, to, agentId) {} catch {}
    }

    function mintedCount() external view returns (uint256) {
        return minted.length;
    }
}

/// @title IdentityBondInvariant
/// @notice The registry is a bonded escrow: every wei it holds must be attributable to an
///         outstanding bond or to a refund escrowed for a recipient who rejected payment.
/// @dev Invariant target: `sum(bondPaid) == address(registry).balance - escrowedRefunds()`.
///      A direct push-refund, a double refund or an unaccounted transfer would break it.
contract IdentityBondInvariantTest is Test {
    AvairaIdentityRegistry internal registry;
    IdentityBondHandler internal handler;

    address internal admin = makeAddr("inv-admin");

    function setUp() public {
        registry = new AvairaIdentityRegistry(0.05 ether, admin);
        vm.deal(address(this), 1000 ether);
        handler = new IdentityBondHandler(registry);

        // The enforcer must be a contract/test address, not the handler.
        vm.prank(admin);
        registry.setEnforcer(address(this));

        targetContract(address(handler));
    }

    /// @notice Every held wei is either an outstanding bond or an escrowed refund.
    function invariant_BondsFullyBacked() public view {
        uint256 outstanding;
        uint256 next = registry.nextAgentId();
        for (uint256 id = 1; id < next; ++id) {
            outstanding += registry.bondPaid(id);
        }

        assertEq(
            outstanding,
            address(registry).balance - registry.escrowedRefunds(),
            "registry balance must be exactly the sum of outstanding bonds"
        );
    }

    /// @notice `totalBonds()` excludes escrowed refunds, so the two never double-count.
    function invariant_TotalBondsExcludesEscrow() public view {
        assertEq(registry.totalBonds(), address(registry).balance - registry.escrowedRefunds());
    }

    /// @notice The handler actually exercised the state space.
    function afterInvariant() public view {
        assertGt(handler.registrations(), 0, "handler never registered an agent");
    }
}
