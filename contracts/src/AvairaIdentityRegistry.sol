// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Trust infrastructure for autonomous agents — Monad-native.

        Component 1 of 6: AvairaIdentityRegistry
        ----------------------------------------
        Canonical Monad deployment of the ERC-8004 Identity Registry, hardened with
        a refundable registration bond.

        Why the bond exists (arXiv:2606.26028, "Can Trustless Agents Be Trusted?",
        Imperial College London, June 2026): the study crawled every live ERC-8004
        deployment and found that 97% / 96% / 85% of registrations on Ethereum, BSC
        and Base are placeholders with no live service, because minting an identity
        costs nothing and buys permanent, transferable, Sybil-batchable identity.
        Avaira requires a real stake to mint and forfeits it on BAN, so the cost of
        manufacturing agent identities is no longer ~$0.

        Spec compliance: ERC-721 + per-agent URI + `getMetadata`/`setMetadata` +
        reserved `agentWallet` key (EIP-712 for EOAs, ERC-1271 for contract wallets,
        auto-cleared on transfer) + `agentRegistry()` string.
//////////////////////////////////////////////////////////////////////////////*/

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";
import {MetadataEntry} from "./interfaces/IAvairaTypes.sol";

interface IStakeRegistryView {
    function stakeOf(uint256 agentId) external view returns (uint256);
    function statusOf(uint256 agentId) external view returns (uint8);
}

contract AvairaIdentityRegistry is IAvairaIdentityRegistry, ERC721, ERC721URIStorage, EIP712, Ownable {
    using Strings for uint256;
    using ECDSA for bytes32;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    bytes32 public constant AGENT_WALLET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,uint256 deadline)");

    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;

    /// @dev Reserved ERC-8004 metadata key — backed by {_agentWallet}, not {_metadata}.
    string public constant AGENT_WALLET_KEY = "agentWallet";

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @notice MON that must accompany {register}.
    uint256 public registrationBond;

    /// @notice When false the bond requirement is waived (testnet bootstrap only).
    bool public bondRequired = true;

    /// @notice Recipient of forfeited bonds.
    address public treasury;

    /// @notice Optional cap on identities per address (0 = unlimited).
    uint256 public maxAgentsPerOwner;

    /// @notice Stake registry authorised to forfeit bonds and authorise exits.
    ///         Zero address during bootstrap: owners may then exit freely.
    address public stakeRegistry;

    /// @notice The address allowed to call {forfeitBond} (set to the stake registry
    ///         once deployed; a dedicated address keeps the two roles decoupled).
    address public slashAuthority;

    uint256 private _nextAgentId = 1;

    mapping(uint256 agentId => uint256 amount) private _bond;
    mapping(uint256 agentId => mapping(string key => bytes value)) private _metadata;
    mapping(uint256 agentId => address wallet) private _agentWallet;
    mapping(address owner => uint256 count) private _agentsOf;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error BondMismatch(uint256 required, uint256 provided);
    error BondNotRequired();
    error NotAgentOwnerOrOperator(uint256 agentId, address caller);
    error ReservedMetadataKey(string key);
    error AgentCountExceeded(address owner, uint256 cap);
    error WalletBindingExpired(uint256 deadline, uint256 timestamp);
    error InvalidWalletSignature();
    error NotNewWallet();
    error NotExitAuthority();
    error StakeStillPosted(uint256 agentId, uint256 stake);
    error NotSlashAuthority();
    error ZeroAddress();
    error UnknownAgent(uint256 agentId);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address treasury_, uint256 registrationBond_)
        ERC721("Avaira Agent Identity", "AVAIRA-ID")
        EIP712("AvairaIdentityRegistry", "1")
        Ownable(initialOwner)
    {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        registrationBond = registrationBond_;
    }

    // -------------------------------------------------------------------------
    // ERC-8004 registry API
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIdentityRegistry
    function register(string calldata agentURI) external payable returns (uint256) {
        return _register(agentURI, new MetadataEntry[](0));
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        payable
        returns (uint256)
    {
        return _register(agentURI, metadata);
    }

    function _register(string calldata agentURI, MetadataEntry[] memory metadata) private returns (uint256 agentId) {
        uint256 required = bondRequired ? registrationBond : 0;
        if (msg.value != required) revert BondMismatch(required, msg.value);

        uint256 count = _agentsOf[msg.sender];
        if (maxAgentsPerOwner != 0 && count >= maxAgentsPerOwner) {
            revert AgentCountExceeded(msg.sender, maxAgentsPerOwner);
        }

        agentId = _nextAgentId++;
        _bond[agentId] = msg.value;
        _agentsOf[msg.sender] = count + 1;

        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        emit Registered(agentId, agentURI, msg.sender);
        if (msg.value != 0) emit BondPosted(agentId, msg.sender, msg.value);

        for (uint256 i = 0; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAgentAuth(agentId);
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        if (keccak256(bytes(metadataKey)) == keccak256(bytes(AGENT_WALLET_KEY))) {
            return abi.encode(_agentWallet[agentId]);
        }
        return _metadata[agentId][metadataKey];
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireAgentAuth(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) private {
        if (bytes(metadataKey).length == 0) revert ReservedMetadataKey(metadataKey);
        if (keccak256(bytes(metadataKey)) == keccak256(bytes(AGENT_WALLET_KEY))) {
            revert ReservedMetadataKey(metadataKey);
        }
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    /// @dev Proof of control of `newWallet` is mandatory:
    ///      - EOA wallet      → EIP-712 signature recovered from `newWallet`.
    ///      - Contract wallet → ERC-1271 `isValidSignature` (Privy passkey smart accounts).
    ///      The caller must additionally be the agent owner or an approved operator.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        _requireAgentAuth(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert WalletBindingExpired(deadline, block.timestamp);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline)));

        if (newWallet.code.length != 0) {
            // Smart account: ask the wallet itself (ERC-1271).
            if (IERC1271(newWallet).isValidSignature(digest, signature) != ERC1271_MAGICVALUE) {
                revert InvalidWalletSignature();
            }
        } else {
            // EOA: the signature must be produced by the wallet being bound.
            address recovered = digest.recover(signature);
            if (recovered != newWallet) revert InvalidWalletSignature();
        }

        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet);
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function unsetAgentWallet(uint256 agentId) external {
        _requireAgentAuth(agentId);
        delete _agentWallet[agentId];
        emit AgentWalletUnset(agentId);
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function getAgentWallet(uint256 agentId) public view returns (address) {
        return _agentWallet[agentId];
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function agentRegistry() external view returns (string memory) {
        return string.concat(
            "eip155:", block.chainid.toString(), ":", Strings.toHexString(address(this))
        );
    }

    // -------------------------------------------------------------------------
    // Avaira bond extension
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIdentityRegistry
    function bondOf(uint256 agentId) external view returns (uint256) {
        return _bond[agentId];
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function isRegistered(uint256 agentId) external view returns (bool) {
        return _ownerOf(agentId) != address(0);
    }

    /// @dev Voluntary exit. Refunds the bond and burns the identity. Blocked while a
    ///      stake is still posted so an agent cannot escape a live slash position by
    ///      deleting its identity — the stake registry must process the withdrawal first.
    function refundBondAndBurn(uint256 agentId) external {
        if (_ownerOf(agentId) == address(0)) revert UnknownAgent(agentId);

        bool authorised = msg.sender == slashAuthority || msg.sender == stakeRegistry;
        if (!authorised) {
            _requireAgentAuth(agentId);
            if (stakeRegistry != address(0)) {
                uint256 stake = IStakeRegistryView(stakeRegistry).stakeOf(agentId);
                if (stake != 0) revert StakeStillPosted(agentId, stake);
            }
        }

        uint256 amount = _bond[agentId];
        address owner_ = ownerOf(agentId);
        delete _bond[agentId];
        _burn(agentId);

        if (amount != 0) {
            (bool ok,) = owner_.call{value: amount}("");
            require(ok, "bond refund failed");
            emit BondRefunded(agentId, owner_, amount);
        }
    }

    /// @dev Called by the slash authority (stake registry) when an agent is BANNED.
    ///      The bond is protocol revenue, not returned to the offender.
    function forfeitBond(uint256 agentId) external {
        if (msg.sender != slashAuthority && msg.sender != owner()) revert NotSlashAuthority();
        uint256 amount = _bond[agentId];
        if (amount == 0) return;
        delete _bond[agentId];
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "bond forfeit failed");
        emit BondForfeited(agentId, treasury, amount);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setRegistrationBond(uint256 newBond) external onlyOwner {
        emit RegistrationBondUpdated(registrationBond, newBond);
        registrationBond = newBond;
    }

    function setBondRequired(bool required) external onlyOwner {
        bondRequired = required;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    function setMaxAgentsPerOwner(uint256 cap) external onlyOwner {
        maxAgentsPerOwner = cap;
    }

    function setStakeRegistry(address registry) external onlyOwner {
        stakeRegistry = registry;
    }

    function setSlashAuthority(address authority) external onlyOwner {
        slashAuthority = authority;
    }

    // -------------------------------------------------------------------------
    // Views / internals
    // -------------------------------------------------------------------------

    /// @notice Number of identities minted by `owner_` (Sybil-cap accounting).
    function agentCountOf(address owner_) external view returns (uint256) {
        return _agentsOf[owner_];
    }

    function nextAgentId() external view returns (uint256) {
        return _nextAgentId;
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return ERC721URIStorage.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage, IERC165)
        returns (bool)
    {
        return ERC721.supportsInterface(interfaceId) || ERC721URIStorage.supportsInterface(interfaceId);
    }

    /// @dev ERC-8004: the agent wallet binding is per-agent, not per-token-holder; it is
    ///      cleared on every transfer so the new owner cannot inherit spending authority.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721)
        returns (address previousOwner)
    {
        previousOwner = super._update(to, tokenId, auth);
        if (previousOwner != address(0) && to != address(0) && _agentWallet[tokenId] != address(0)) {
            delete _agentWallet[tokenId];
            emit AgentWalletUnset(tokenId);
        }
    }

    function _requireAgentAuth(uint256 agentId) private view {
        address owner_ = _ownerOf(agentId);
        if (owner_ == address(0)) revert UnknownAgent(agentId);
        if (
            msg.sender != owner_ && msg.sender != getApproved(agentId)
                && !isApprovedForAll(owner_, msg.sender)
        ) {
            revert NotAgentOwnerOrOperator(agentId, msg.sender);
        }
    }

    /// @dev Accept MON from the treasury / slash flows without reverting.
    receive() external payable {}
}
