// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IAvairaIdentityRegistry, IERC8004IdentityRegistry} from "../interfaces/IERC8004.sol";
import {MetadataEntry, AgentStatus} from "../lib/AvairaTypes.sol";

/// @title AvairaIdentityRegistry
/// @notice ERC-8004 Identity Registry with an Avaira registration bond.
/// @dev Implements the ERC-8004 identity surface verbatim (`register`, `setAgentURI`,
///      `getMetadata`/`setMetadata`, `setAgentWallet` with EIP-712 + ERC-1271,
///      `operatorRegistry`-style `agentRegistry` string) and adds the two Avaira
///      hardening primitives the June 2026 Imperial College study calls for:
///
///      1. **Registration bond** — minting an identity costs a small native MON stake.
///         It is refunded on voluntary exit and forfeited to the protocol treasury on BAN.
///         Fabricating identities is therefore priced, not free (Sybil fix #1).
///      2. **Terminal ban** — a slash outcome at BAN severity permanently marks the
///         identity (and its operator) unusable across the whole Avaira stack.
///
///      `agentWallet` is a reserved metadata key: it is stored in its own slot,
///      returned by `getMetadata`, and auto-cleared on every token transfer.
contract AvairaIdentityRegistry is ERC721URIStorage, Ownable2Step, EIP712, ReentrancyGuard, IAvairaIdentityRegistry {
    using Strings for uint256;
    using Strings for address;

    /* --------------------------------- errors -------------------------------- */

    error InsufficientBond(uint256 required, uint256 provided);
    error InvalidURI();
    error InvalidMetadataKey();
    error ReservedMetadataKey();
    error MetadataTooLarge();
    error NotAgentOwnerOrApproved(uint256 agentId);
    error AgentIsBanned(uint256 agentId);
    error AgentIsNotRegistered(uint256 agentId);
    error OperatorIsBanned(address operator);
    error SignatureExpired(uint256 deadline);
    error InvalidAgentWalletSignature(address newWallet, uint256 nonce);
    error WalletUnchanged();
    error NotAuthorized(address caller);

    /* --------------------------------- events -------------------------------- */

    /// @notice Emitted when a bond refund has to be escrowed for pull-based withdrawal.
    event RefundEscrowed(address indexed recipient, uint256 amount);

    /* -------------------------------- constants ------------------------------- */

    /// @notice Reserved metadata key holding the agent's wallet binding.
    string public constant AGENT_WALLET_KEY = "agentWallet";

    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)");

    uint256 private constant MAX_URI_LENGTH = 2048;
    uint256 private constant MAX_METADATA_KEY_LENGTH = 128;
    uint256 private constant MAX_METADATA_VALUE_LENGTH = 8192;

    /* ---------------------------------- state -------------------------------- */

    /// @notice Native MON required to mint an agent identity. Configurable by the owner.
    uint256 public registrationBond;

    /// @notice Recipient of forfeited bonds.
    address public treasury;

    /// @notice Authorised caller for `banAgent` (the AvairaStakeRegistry).
    address public enforcer;

    /// @notice Number of identities currently minted and not exited.
    uint256 public activeAgents;

    /// @notice Monotonic agent id counter; ids start at 1.
    uint256 public nextAgentId = 1;

    /// @notice Bond amount actually escrowed for each agent at registration time.
    /// @dev Refunds and forfeits always use this value, never the current `registrationBond`.
    mapping(uint256 agentId => uint256) public bondPaid;

    mapping(uint256 agentId => bool) private _banned;
    mapping(address operator => bool) public bannedOperators;
    mapping(uint256 agentId => address) private _agentWallet;
    mapping(uint256 agentId => uint256) public agentWalletNonce;
    mapping(uint256 agentId => mapping(string key => bytes)) private _metadata;
    mapping(uint256 agentId => string[] keys) private _metadataKeys;
    mapping(address account => uint256) public pendingWithdrawals;

    /// @dev Aggregate of `pendingWithdrawals`; keeps bond accounting exact:
    ///      `address(this).balance == totalBonds + totalEscrowed`.
    uint256 private _totalEscrowed;

    /* -------------------------------- modifiers ------------------------------ */

    modifier notBanned(uint256 agentId) {
        if (_banned[agentId]) revert AgentIsBanned(agentId);
        _;
    }

    modifier onlyAgentOwnerOrApproved(uint256 agentId) {
        if (!_isAuthorized(_requireOwned(agentId), msg.sender, agentId)) revert NotAgentOwnerOrApproved(agentId);
        _;
    }

    /* ------------------------------- constructor ----------------------------- */

    constructor(uint256 initialRegistrationBond, address initialOwner)
        ERC721("Avaira Agent", "AVA")
        EIP712("AvairaIdentityRegistry", "1")
        Ownable(initialOwner)
    {
        registrationBond = initialRegistrationBond;
        treasury = initialOwner;
        emit RegistrationBondUpdated(0, initialRegistrationBond);
        emit TreasuryUpdated(address(0), initialOwner);
    }

    /* -------------------------------- registration --------------------------- */

    /// @inheritdoc IERC8004IdentityRegistry
    function register(string calldata agentURI) external payable override returns (uint256 agentId) {
        return _register(agentURI, new MetadataEntry[](0));
    }

    /// @inheritdoc IERC8004IdentityRegistry
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        payable
        override
        returns (uint256 agentId)
    {
        return _register(agentURI, metadata);
    }

    function _register(string calldata agentURI, MetadataEntry[] memory metadata)
        internal
        nonReentrant
        returns (uint256 agentId)
    {
        if (bannedOperators[msg.sender]) revert OperatorIsBanned(msg.sender);
        uint256 bond = registrationBond;
        if (msg.value < bond) revert InsufficientBond(bond, msg.value);
        if (bytes(agentURI).length == 0 || bytes(agentURI).length > MAX_URI_LENGTH) revert InvalidURI();

        agentId = nextAgentId++;
        bondPaid[agentId] = bond;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        activeAgents += 1;

        emit Registered(agentId, agentURI, msg.sender);

        uint256 len = metadata.length;
        for (uint256 i; i < len; ++i) {
            MetadataEntry memory entry = metadata[i];
            _setMetadata(agentId, entry.metadataKey, entry.metadataValue);
        }

        // Refund any overpayment; fall back to a pull-based escrow if the recipient rejects native value.
        uint256 excess = msg.value - bond;
        if (excess > 0) _pay(msg.sender, excess);
    }

    /* ------------------------------ registration uri ------------------------- */

    /// @inheritdoc IERC8004IdentityRegistry
    function setAgentURI(uint256 agentId, string calldata newURI)
        external
        onlyAgentOwnerOrApproved(agentId)
        notBanned(agentId)
    {
        if (bytes(newURI).length == 0 || bytes(newURI).length > MAX_URI_LENGTH) revert InvalidURI();
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @inheritdoc ERC721URIStorage
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return super.tokenURI(tokenId);
    }

    /* --------------------------------- metadata ------------------------------ */

    /// @inheritdoc IERC8004IdentityRegistry
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value)
        external
        onlyAgentOwnerOrApproved(agentId)
        notBanned(agentId)
    {
        _setMetadata(agentId, key, value);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        uint256 keyLength = bytes(key).length;
        if (keyLength == 0 || keyLength > MAX_METADATA_KEY_LENGTH) revert InvalidMetadataKey();
        if (keccak256(bytes(key)) == keccak256(bytes(AGENT_WALLET_KEY))) revert ReservedMetadataKey();
        if (value.length > MAX_METADATA_VALUE_LENGTH) revert MetadataTooLarge();

        if (_metadata[agentId][key].length == 0) _metadataKeys[agentId].push(key);
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    /// @inheritdoc IERC8004IdentityRegistry
    function getMetadata(uint256 agentId, string calldata key) external view override returns (bytes memory) {
        if (keccak256(bytes(key)) == keccak256(bytes(AGENT_WALLET_KEY))) {
            return abi.encode(_agentWallet[agentId]);
        }
        return _metadata[agentId][key];
    }

    /// @notice Enumerates the metadata keys written for `agentId`.
    function getMetadataKeys(uint256 agentId) external view returns (string[] memory) {
        return _metadataKeys[agentId];
    }

    /* ------------------------------- agent wallet ---------------------------- */

    /// @inheritdoc IERC8004IdentityRegistry
    /// @dev `signature` is an EIP-712 `AgentWalletSet` authorisation produced by `newWallet`.
    ///      EOAs are verified with `ecrecover`, contract wallets (e.g. Privy passkey smart
    ///      accounts) with ERC-1271.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
        override
        onlyAgentOwnerOrApproved(agentId)
        notBanned(agentId)
    {
        // forge-lint: disable-next-line(block-timestamp) -- signature deadlines are time-based by design
        if (deadline < block.timestamp) revert SignatureExpired(deadline);
        if (newWallet == address(0)) revert InvalidAgentWalletSignature(newWallet, agentWalletNonce[agentId]);

        uint256 nonce = agentWalletNonce[agentId]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, nonce, deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) {
            revert InvalidAgentWalletSignature(newWallet, nonce);
        }

        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet, msg.sender);
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(newWallet));
    }

    /// @inheritdoc IERC8004IdentityRegistry
    function unsetAgentWallet(uint256 agentId) external override onlyAgentOwnerOrApproved(agentId) {
        if (_agentWallet[agentId] == address(0)) revert WalletUnchanged();
        delete _agentWallet[agentId];
        emit AgentWalletUnset(agentId, msg.sender);
    }

    /// @inheritdoc IERC8004IdentityRegistry
    function getAgentWallet(uint256 agentId) external view override returns (address) {
        return _agentWallet[agentId];
    }

    /// @notice EIP-712 digest an agent wallet must sign to be bound to `agentId`.
    function hashAgentWalletSet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, nonce, deadline))
        );
    }

    /* ----------------------------- lifecycle (Avaira) ------------------------ */

    /// @notice Voluntary exit: burns the identity and refunds the registration bond.
    /// @dev Stakes held in `AvairaStakeRegistry` must be withdrawn separately.
    function exitAgent(uint256 agentId) external onlyAgentOwnerOrApproved(agentId) nonReentrant {
        if (_banned[agentId]) revert AgentIsBanned(agentId);
        address owner_ = ownerOf(agentId);
        uint256 bond = bondPaid[agentId];
        delete bondPaid[agentId];
        _burn(agentId);
        activeAgents -= 1;
        emit AgentExited(agentId, owner_, bond);
        if (bond > 0) _pay(owner_, bond);
    }

    /// @notice Terminal ban: forfeits the registration bond to the treasury.
    /// @dev Callable by the owner or the configured `enforcer` (AvairaStakeRegistry).
    ///      The ERC-721 identity is retained so that onchain history stays auditable,
    ///      but `statusOf` reports BANNED forever and every Avaira contract rejects it.
    function banAgent(uint256 agentId, string calldata reason) external {
        if (msg.sender != owner() && msg.sender != enforcer) revert NotAuthorized(msg.sender);
        if (_ownerOf(agentId) == address(0)) revert AgentIsNotRegistered(agentId);
        if (_banned[agentId]) revert AgentIsBanned(agentId);

        _banned[agentId] = true;
        delete _agentWallet[agentId];

        uint256 forfeited;
        if (activeAgents > 0) activeAgents -= 1;
        uint256 bond = bondPaid[agentId];
        delete bondPaid[agentId];
        uint256 balance = address(this).balance - _escrowedBalance();
        if (balance >= bond) {
            forfeited = bond;
            _pay(treasury, bond);
        }

        emit AgentBanned(agentId, msg.sender, forfeited, reason);
        emit AgentWalletUnset(agentId, msg.sender);
    }

    /// @notice Bans an entire operator address from minting new Avaira identities.
    /// @dev Used when BAN-severity slashing shows the operator, not just one agent, is malicious.
    function banOperator(address operator) external {
        if (msg.sender != owner() && msg.sender != enforcer) revert NotAuthorized(msg.sender);
        bannedOperators[operator] = true;
    }

    /* ---------------------------------- views -------------------------------- */

    /// @inheritdoc IAvairaIdentityRegistry
    function isBanned(uint256 agentId) external view override returns (bool) {
        return _banned[agentId];
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function isActive(uint256 agentId) external view override returns (bool) {
        return _ownerOf(agentId) != address(0) && !_banned[agentId];
    }

    /// @inheritdoc IAvairaIdentityRegistry
    function statusOf(uint256 agentId) external view override returns (AgentStatus) {
        if (_banned[agentId]) return AgentStatus.BANNED;
        if (_ownerOf(agentId) == address(0)) return AgentStatus.NONE;
        return AgentStatus.ACTIVE;
    }

    /// @inheritdoc IERC8004IdentityRegistry
    function agentRegistry() external view override returns (string memory) {
        return string.concat("eip155:", block.chainid.toString(), ":", address(this).toHexString());
    }

    /// @notice Total native MON held as registration bonds.
    function totalBonds() external view returns (uint256) {
        return address(this).balance - _escrowedBalance();
    }

    /// @notice Native MON escrowed for refunds that could not be pushed to their recipient.
    function escrowedRefunds() external view returns (uint256) {
        return _totalEscrowed;
    }

    /* --------------------------------- admin --------------------------------- */

    function setRegistrationBond(uint256 newBond) external onlyOwner {
        emit RegistrationBondUpdated(registrationBond, newBond);
        registrationBond = newBond;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert NotAuthorized(newTreasury);
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @param newEnforcer The AvairaStakeRegistry that propagates BAN outcomes. Zero is
    ///        rejected: with no enforcer a BAN at the stake layer could never reach the
    ///        identity, and the terminal state would silently stop being terminal.
    function setEnforcer(address newEnforcer) external onlyOwner {
        if (newEnforcer == address(0)) revert NotAuthorized(newEnforcer);
        emit EnforcerUpdated(enforcer, newEnforcer);
        enforcer = newEnforcer;
    }

    /// @notice Withdraws a refund that could not be pushed to the recipient.
    /// @dev If the push fails again (e.g. the recipient is a contract that rejects native
    ///      value in this code path) the credit is re-escrowed instead of reverting, so the
    ///      funds stay claimable rather than becoming permanently unreachable. (Audit E1.)
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) return;
        pendingWithdrawals[msg.sender] = 0;
        _totalEscrowed -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[msg.sender] += amount;
            _totalEscrowed += amount;
            emit RefundEscrowed(msg.sender, amount);
        }
    }

    /* -------------------------------- internals ------------------------------ */

    /// @dev Agent-wallet binding is invalidated on transfer (ERC-8004 reserved-key semantics).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && _agentWallet[tokenId] != address(0)) {
            delete _agentWallet[tokenId];
            emit AgentWalletUnset(tokenId, msg.sender);
        }
    }

    /// @dev Native MON escrowed for refunds that could not be pushed.
    function _escrowedBalance() private view returns (uint256) {
        return _totalEscrowed;
    }

    function _pay(address recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[recipient] += amount;
            _totalEscrowed += amount;
            emit RefundEscrowed(recipient, amount);
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage) returns (bool) {
        return interfaceId == type(IAvairaIdentityRegistry).interfaceId || super.supportsInterface(interfaceId);
    }
}
