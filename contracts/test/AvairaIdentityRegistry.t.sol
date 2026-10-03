// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {console2} from "forge-std/console2.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {IAvairaIdentityRegistry} from "avaira/interfaces/IERC8004.sol";
import {MetadataEntry, AgentStatus} from "avaira/lib/AvairaTypes.sol";
import {MockERC1271Wallet, NativeRejector, NativeAcceptor} from "./mocks/Mocks.sol";

/// @title AvairaIdentityRegistryTest — Component 1 (ERC-8004 Identity + registration bond)
contract AvairaIdentityRegistryTest is Test {
    AvairaIdentityRegistry internal registry;

    uint256 internal constant BOND = 0.05 ether;
    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant WALLET_PK = 0xB0B;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal enforcer = makeAddr("enforcer");

    string internal constant URI_1 = "ipfs://bafybeigd/agent-alice.json";
    string internal constant URI_2 = "ipfs://bafybeigd/agent-alice-v2.json";

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event AgentWalletSet(uint256 indexed agentId, address indexed newWallet, address indexed setBy);
    event AgentWalletUnset(uint256 indexed agentId, address indexed unsetBy);
    event AgentBanned(uint256 indexed agentId, address indexed enforcer, uint256 forfeitedBond, string reason);
    event AgentExited(uint256 indexed agentId, address indexed owner, uint256 refundedBond);

    function setUp() public {
        registry = new AvairaIdentityRegistry(BOND, owner);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.prank(owner);
        registry.setTreasury(treasury);
        vm.prank(owner);
        registry.setEnforcer(enforcer);
    }

    /* ------------------------------ helpers ------------------------------ */

    function _register(address who, string memory uri) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = registry.register{value: BOND}(uri);
    }

    function _registerWithMetadata(address who, MetadataEntry[] memory entries) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = registry.register{value: BOND}(URI_1, entries);
    }

    function _signWalletSet(uint256 pk, uint256 agentId, address newWallet, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = registry.hashAgentWalletSet(agentId, newWallet, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /* ------------------------------ registration ------------------------------ */

    function test_Register_RequiresAndStoresBond() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit Registered(1, URI_1, alice);

        vm.prank(alice);
        uint256 agentId = registry.register{value: BOND}(URI_1);

        assertEq(agentId, 1, "first agentId must be 1");
        assertEq(registry.ownerOf(agentId), alice);
        assertEq(registry.tokenURI(agentId), URI_1);
        assertEq(registry.activeAgents(), 1);
        assertEq(registry.totalBonds(), BOND);
        assertEq(address(registry).balance, BOND);
        assertEq(uint256(registry.statusOf(agentId)), uint256(AgentStatus.ACTIVE));
        assertTrue(registry.isActive(agentId));
    }

    function test_Register_RevertsWhenBondNotPaid() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InsufficientBond.selector, BOND, 0));
        registry.register(URI_1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InsufficientBond.selector, BOND, BOND - 1));
        registry.register{value: BOND - 1}(URI_1);
    }

    function test_Register_RefundsExcessBond() public {
        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        registry.register{value: BOND + 0.5 ether}(URI_1);
        assertEq(alice.balance, balanceBefore - BOND, "excess must be refunded");
        assertEq(registry.totalBonds(), BOND);
    }

    function test_Register_IdsAreMonotonic() public {
        assertEq(_register(alice, URI_1), 1);
        assertEq(_register(bob, URI_1), 2);
        assertEq(registry.nextAgentId(), 3);
        assertEq(registry.activeAgents(), 2);
    }

    function test_Register_RevertsOnEmptyOrOversizedURI() public {
        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.InvalidURI.selector);
        registry.register{value: BOND}("");

        string memory huge = new string(2049);
        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.InvalidURI.selector);
        registry.register{value: BOND}(huge);
    }

    function test_Register_WithMetadataWritesEveryEntry() public {
        MetadataEntry[] memory entries = new MetadataEntry[](2);
        entries[0] = MetadataEntry({metadataKey: "name", metadataValue: bytes("avaira-research-agent")});
        entries[1] = MetadataEntry({metadataKey: "x402Support", metadataValue: abi.encode(true)});

        vm.expectEmit(true, true, true, true, address(registry));
        emit MetadataSet(1, "name", "name", bytes("avaira-research-agent"));

        uint256 agentId = _registerWithMetadata(alice, entries);

        assertEq(registry.getMetadata(agentId, "name"), bytes("avaira-research-agent"));
        assertEq(registry.getMetadata(agentId, "x402Support"), abi.encode(true));
        string[] memory keys = registry.getMetadataKeys(agentId);
        assertEq(keys.length, 2);
        assertEq(keys[0], "name");
    }

    function test_Register_RevertsOnReservedAgentWalletMetadataKey() public {
        MetadataEntry[] memory entries = new MetadataEntry[](1);
        entries[0] = MetadataEntry({metadataKey: "agentWallet", metadataValue: abi.encode(alice)});

        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.ReservedMetadataKey.selector);
        registry.register{value: BOND}(URI_1, entries);
    }

    function test_Register_RevertsOnEmptyMetadataKey() public {
        MetadataEntry[] memory entries = new MetadataEntry[](1);
        entries[0] = MetadataEntry({metadataKey: "", metadataValue: bytes("x")});

        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.InvalidMetadataKey.selector);
        registry.register{value: BOND}(URI_1, entries);
    }

    function test_Register_ZeroBondWhenOwnerDisablesIt() public {
        vm.prank(owner);
        registry.setRegistrationBond(0);
        vm.prank(bob);
        uint256 agentId = registry.register(URI_1);
        assertEq(agentId, 1);
        assertEq(registry.totalBonds(), 0);
    }

    /* ---------------------------------- URI ---------------------------------- */

    function test_SetAgentURI_ByOwnerAndApprovedOperator() public {
        uint256 agentId = _register(alice, URI_1);

        vm.expectEmit(true, true, true, true, address(registry));
        emit URIUpdated(agentId, URI_2, alice);
        vm.prank(alice);
        registry.setAgentURI(agentId, URI_2);
        assertEq(registry.tokenURI(agentId), URI_2);

        // Approved operator path
        vm.prank(alice);
        registry.approve(bob, agentId);
        vm.prank(bob);
        registry.setAgentURI(agentId, URI_1);
        assertEq(registry.tokenURI(agentId), URI_1);
    }

    function test_SetAgentURI_RevertsForStranger() public {
        uint256 agentId = _register(alice, URI_1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAgentOwnerOrApproved.selector, agentId));
        registry.setAgentURI(agentId, URI_2);
    }

    function test_SetAgentURI_RevertsForUnknownAgent() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 42));
        registry.setAgentURI(42, URI_2);
    }

    /* -------------------------------- metadata -------------------------------- */

    function test_SetMetadata_RoundTripAndKeys() public {
        uint256 agentId = _register(alice, URI_1);

        vm.prank(alice);
        registry.setMetadata(agentId, "sla", bytes("99.95%"));

        assertEq(registry.getMetadata(agentId, "sla"), bytes("99.95%"));
        assertEq(registry.getMetadataKeys(agentId).length, 1);

        // Overwrite must not duplicate the key
        vm.prank(alice);
        registry.setMetadata(agentId, "sla", bytes("99.99%"));
        assertEq(registry.getMetadata(agentId, "sla"), bytes("99.99%"));
        assertEq(registry.getMetadataKeys(agentId).length, 1);
    }

    function test_SetMetadata_RevertsForNonOwnerAndReservedKey() public {
        uint256 agentId = _register(alice, URI_1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAgentOwnerOrApproved.selector, agentId));
        registry.setMetadata(agentId, "sla", bytes("x"));

        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.ReservedMetadataKey.selector);
        registry.setMetadata(agentId, "agentWallet", abi.encode(bob));
    }

    function test_GetMetadata_AgentWalletIsDerivedFromBinding() public {
        uint256 agentId = _register(alice, URI_1);
        assertEq(registry.getMetadata(agentId, "agentWallet"), abi.encode(address(0)));

        address newWallet = vm.addr(WALLET_PK);
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, block.timestamp + 1 hours);
        vm.prank(alice);
        registry.setAgentWallet(agentId, newWallet, block.timestamp + 1 hours, sig);

        assertEq(registry.getMetadata(agentId, "agentWallet"), abi.encode(newWallet));
    }

    /* ------------------------------ agent wallet ------------------------------ */

    function test_SetAgentWallet_EOA() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentWalletSet(agentId, newWallet, alice);
        vm.prank(alice);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);

        assertEq(registry.getAgentWallet(agentId), newWallet);
        assertEq(registry.agentWalletNonce(agentId), 1);
    }

    function test_SetAgentWallet_RevertsOnExpiredDeadline() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.SignatureExpired.selector, deadline));
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    function test_SetAgentWallet_RejectsReplay() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);

        vm.prank(alice);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);

        // Same signature, next nonce => invalid
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InvalidAgentWalletSignature.selector, newWallet, 1));
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    function test_SetAgentWallet_RevertsForWrongSignerAndWrongCaller() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp + 1 hours;
        // Signed by the wrong key
        bytes memory sig = _signWalletSet(ALICE_PK, agentId, newWallet, 0, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InvalidAgentWalletSignature.selector, newWallet, 0));
        registry.setAgentWallet(agentId, newWallet, deadline, sig);

        // Correct signature, unauthorised caller
        sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAgentOwnerOrApproved.selector, agentId));
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    function test_SetAgentWallet_RevertsOnZeroWallet() public {
        uint256 agentId = _register(alice, URI_1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InvalidAgentWalletSignature.selector, address(0), 0));
        registry.setAgentWallet(agentId, address(0), block.timestamp + 1 hours, "");
    }

    /// @dev Privy passkey accounts are contracts; ERC-1271 must be honoured.
    function test_SetAgentWallet_ERC1271SmartAccount() public {
        uint256 agentId = _register(alice, URI_1);
        address passkeySigner = vm.addr(WALLET_PK);
        MockERC1271Wallet smartAccount = new MockERC1271Wallet(passkeySigner);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, address(smartAccount), 0, deadline);

        vm.prank(alice);
        registry.setAgentWallet(agentId, address(smartAccount), deadline, sig);

        assertEq(registry.getAgentWallet(agentId), address(smartAccount));
    }

    function test_UnsetAgentWallet() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);
        vm.prank(alice);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentWalletUnset(agentId, alice);
        vm.prank(alice);
        registry.unsetAgentWallet(agentId);
        assertEq(registry.getAgentWallet(agentId), address(0));

        vm.prank(alice);
        vm.expectRevert(AvairaIdentityRegistry.WalletUnchanged.selector);
        registry.unsetAgentWallet(agentId);
    }

    function test_Transfer_ClearsAgentWallet() public {
        uint256 agentId = _register(alice, URI_1);
        address newWallet = vm.addr(WALLET_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWalletSet(WALLET_PK, agentId, newWallet, 0, deadline);
        vm.prank(alice);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentWalletUnset(agentId, alice);
        vm.prank(alice);
        registry.transferFrom(alice, bob, agentId);

        assertEq(registry.getAgentWallet(agentId), address(0), "reserved key must be cleared on transfer");
        assertEq(registry.ownerOf(agentId), bob);
        assertEq(registry.activeAgents(), 1, "transfer is not an exit");
    }

    /* ------------------------------ ban and exit ------------------------------ */

    function test_ExitAgent_RefundsBondAndBurns() public {
        uint256 agentId = _register(alice, URI_1);
        uint256 balanceAfterRegister = alice.balance;

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentExited(agentId, alice, BOND);
        vm.prank(alice);
        registry.exitAgent(agentId);

        assertEq(alice.balance, balanceAfterRegister + BOND, "bond must be refunded");
        assertEq(registry.activeAgents(), 0);
        assertEq(registry.totalBonds(), 0);
        assertEq(uint256(registry.statusOf(agentId)), uint256(AgentStatus.NONE));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, agentId));
        registry.ownerOf(agentId);
    }

    function test_ExitAgent_RevertsForNonOwner() public {
        uint256 agentId = _register(alice, URI_1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAgentOwnerOrApproved.selector, agentId));
        registry.exitAgent(agentId);
    }

    function test_BanAgent_ForfeitsBondToTreasuryAndIsTerminal() public {
        uint256 agentId = _register(alice, URI_1);

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentBanned(agentId, enforcer, BOND, "deviation: spend exceeded envelope");
        vm.prank(enforcer);
        registry.banAgent(agentId, "deviation: spend exceeded envelope");

        assertEq(treasury.balance, BOND, "bond must be forfeited to the treasury");
        assertEq(registry.totalBonds(), 0);
        assertTrue(registry.isBanned(agentId));
        assertFalse(registry.isActive(agentId));
        assertEq(uint256(registry.statusOf(agentId)), uint256(AgentStatus.BANNED));

        // A banned identity can no longer mutate state or exit.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.AgentIsBanned.selector, agentId));
        registry.setAgentURI(agentId, URI_2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.AgentIsBanned.selector, agentId));
        registry.exitAgent(agentId);
        vm.prank(enforcer);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.AgentIsBanned.selector, agentId));
        registry.banAgent(agentId, "again");
    }

    function test_BanAgent_OnlyOwnerOrEnforcer() public {
        uint256 agentId = _register(alice, URI_1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAuthorized.selector, bob));
        registry.banAgent(agentId, "nope");
    }

    function test_BanOperator_BlocksNewIdentities() public {
        vm.prank(owner);
        registry.banOperator(bob);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.OperatorIsBanned.selector, bob));
        registry.register{value: BOND}(URI_1);
    }

    /* ------------------------------- payments -------------------------------- */

    function test_Refund_EscrowsWhenOwnerRejectsNative() public {
        NativeRejector rejector = new NativeRejector();
        vm.deal(address(rejector), 1 ether);

        vm.prank(address(rejector));
        uint256 agentId = registry.register{value: BOND + 0.1 ether}(URI_1);
        assertEq(agentId, 1);
        assertEq(registry.pendingWithdrawals(address(rejector)), 0.1 ether, "excess escrowed");
        assertEq(address(registry).balance, BOND + 0.1 ether);
        assertEq(registry.totalBonds(), BOND, "escrow is not counted as a bond");

        // Exit: bond refund also escrows.
        vm.prank(address(rejector));
        registry.exitAgent(agentId);
        assertEq(registry.pendingWithdrawals(address(rejector)), 0.1 ether + BOND);
    }

    function test_Withdraw_PaysEscrowedRefund() public {
        NativeRejector rejector = new NativeRejector();
        vm.deal(address(rejector), 1 ether);
        vm.prank(address(rejector));
        registry.register{value: BOND + 0.1 ether}(URI_1);

        // Once the recipient can receive value again, the escrow is withdrawable.
        vm.etch(address(rejector), address(new NativeAcceptor()).code);
        uint256 balanceBefore = address(rejector).balance;
        vm.prank(address(rejector));
        registry.withdraw();
        assertEq(address(rejector).balance, balanceBefore + 0.1 ether);
        assertEq(registry.pendingWithdrawals(address(rejector)), 0);
    }

    /* --------------------------------- admin --------------------------------- */

    function test_Admin_OnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setRegistrationBond(1 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setTreasury(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setEnforcer(alice);
        vm.stopPrank();
    }

    function test_SetRegistrationBond_AffectsNewRegistrationsOnly() public {
        uint256 agentId = _register(alice, URI_1);

        vm.prank(owner);
        registry.setRegistrationBond(1 ether);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.InsufficientBond.selector, 1 ether, BOND));
        registry.register{value: BOND}(URI_1);

        // Existing agent keeps the bond it paid, not the new (higher) rate.
        assertEq(registry.registrationBond(), 1 ether);
        assertEq(registry.bondPaid(agentId), BOND);
        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        registry.exitAgent(agentId);
        assertEq(alice.balance, balanceBefore + BOND);
    }

    /* ---------------------------- ERC-8004 surface ---------------------------- */

    function test_AgentRegistry_FormatIsEip155() public view {
        string memory expected =
            string.concat("eip155:", vm.toString(block.chainid), ":", vm.toLowercase(vm.toString(address(registry))));
        assertEq(registry.agentRegistry(), expected);
    }

    function test_SupportsInterface() public view {
        assertTrue(registry.supportsInterface(0x01ffc9a7), "ERC-165");
        assertTrue(registry.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(registry.supportsInterface(0x5b5e139f), "ERC-721 Metadata");
        assertTrue(registry.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(registry.supportsInterface(type(IAvairaIdentityRegistry).interfaceId), "Avaira identity");
        assertFalse(registry.supportsInterface(0xdeadbeef));
    }

    /* ---------------------------------- fuzz --------------------------------- */

    function testFuzz_Register_AnyBond(uint96 bondSeed, uint96 overpaySeed) public {
        uint256 bond = uint256(bondSeed) % 5 ether;
        uint256 overpay = uint256(overpaySeed) % 5 ether;
        vm.prank(owner);
        registry.setRegistrationBond(bond);

        vm.deal(bob, uint256(bond) + overpay);
        vm.prank(bob);
        uint256 agentId = registry.register{value: bond + overpay}(URI_1);

        assertEq(registry.ownerOf(agentId), bob);
        assertEq(bob.balance, overpay, "only the bond is retained");
        assertEq(registry.totalBonds(), bond);
    }

    function testFuzz_Metadata_RoundTrip(string calldata key, bytes calldata value) public {
        vm.assume(bytes(key).length > 0 && bytes(key).length <= 128);
        vm.assume(keccak256(bytes(key)) != keccak256(bytes("agentWallet")));
        vm.assume(value.length <= 8192);

        uint256 agentId = _register(alice, URI_1);
        vm.prank(alice);
        registry.setMetadata(agentId, key, value);
        assertEq(registry.getMetadata(agentId, key), value);
    }

    function testFuzz_ExitAgent_AlwaysRefundsExactlyBond(uint8 exits) public {
        uint256 count = uint256(exits) % 8;
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _register(alice, URI_1);
        }
        uint256 balanceBefore = alice.balance;
        for (uint256 i; i < count; ++i) {
            vm.prank(alice);
            registry.exitAgent(ids[i]);
        }
        assertEq(alice.balance, balanceBefore + count * BOND);
        assertEq(address(registry).balance, 0);
    }
}
