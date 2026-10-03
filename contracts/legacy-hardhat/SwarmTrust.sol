// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SwarmTrust
 * @notice Weighted directed trust graph between AVAIRA agents.
 *
 * Design:
 *   - Trust is directional: A vouching for B does NOT mean B vouches for A.
 *   - weightBps: % of voucher's score at risk if vouchee is slashed (max 2000 = 20%).
 *   - Trust expires after TRUST_TTL without renewal.
 *   - Max vouches per agent: MAX_VOUCHES (gas safety).
 *   - Self-vouch reverts.
 *   - Slash propagation: when B is slashed, A's score is penalized ∝ weightBps.
 */
contract SwarmTrust is Ownable {
    uint256 public constant MAX_VOUCHES    = 10;
    uint256 public constant TRUST_TTL      = 30 days;
    uint256 public constant MAX_WEIGHT_BPS = 2000;

    struct TrustEdge {
        address voucher;
        address vouchee;
        uint256 weightBps;
        uint256 createdAt;
        uint256 expiresAt;
        bool    active;
    }

    /// @dev trustEdges[voucher][vouchee]
    mapping(address => mapping(address => TrustEdge)) public trustEdges;

    /// @dev Active vouchee list per voucher (bounded by MAX_VOUCHES)
    mapping(address => address[]) private _vouchees;

    /// @notice Contract authorized to notify slash events
    address public reputationContract;

    event Vouched(address indexed voucher, address indexed vouchee, uint256 weightBps, uint256 expiresAt);
    event VouchRevoked(address indexed voucher, address indexed vouchee);
    event VouchRenewed(address indexed voucher, address indexed vouchee, uint256 newExpiry);
    event ProtocolAuthorizationUpdated(address indexed actor, bool authorized);

    error SelfVouch();
    error AlreadyVouching();
    error MaxVouchesReached();
    error WeightOutOfRange();
    error NotVouching();
    error Unauthorized();

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Vouch for another agent. Puts a portion of your score at risk.
     * @param vouchee   The agent you are vouching for.
     * @param weightBps Basis points of your score at risk (1–2000).
     */
    function vouch(address vouchee, uint256 weightBps) external {
        if (vouchee == msg.sender)                         revert SelfVouch();
        if (trustEdges[msg.sender][vouchee].active)        revert AlreadyVouching();
        if (_vouchees[msg.sender].length >= MAX_VOUCHES)   revert MaxVouchesReached();
        if (weightBps == 0 || weightBps > MAX_WEIGHT_BPS) revert WeightOutOfRange();

        uint256 expiry = block.timestamp + TRUST_TTL;
        trustEdges[msg.sender][vouchee] = TrustEdge({
            voucher:   msg.sender,
            vouchee:   vouchee,
            weightBps: weightBps,
            createdAt: block.timestamp,
            expiresAt: expiry,
            active:    true
        });
        _vouchees[msg.sender].push(vouchee);
        emit Vouched(msg.sender, vouchee, weightBps, expiry);
    }

    /**
     * @notice Revoke an active vouch. Removes your skin-in-the-game.
     */
    function revokeVouch(address vouchee) external {
        if (!trustEdges[msg.sender][vouchee].active) revert NotVouching();
        trustEdges[msg.sender][vouchee].active = false;
        _removeVouchee(msg.sender, vouchee);
        emit VouchRevoked(msg.sender, vouchee);
    }

    /**
     * @notice Renew an existing vouch, resetting the TTL.
     */
    function renewVouch(address vouchee) external {
        TrustEdge storage edge = trustEdges[msg.sender][vouchee];
        if (!edge.active) revert NotVouching();
        edge.expiresAt = block.timestamp + TRUST_TTL;
        emit VouchRenewed(msg.sender, vouchee, edge.expiresAt);
    }

    /**
     * @notice Returns all active, non-expired vouches made by an agent.
     * @param voucher The agent whose outgoing vouches to query.
     */
    function getVouches(address voucher)
        external
        view
        returns (TrustEdge[] memory edges)
    {
        address[] memory vouchees = _vouchees[voucher];
        TrustEdge[] memory temp = new TrustEdge[](vouchees.length);
        uint256 count = 0;
        for (uint256 i = 0; i < vouchees.length; i++) {
            TrustEdge memory edge = trustEdges[voucher][vouchees[i]];
            if (edge.active && block.timestamp <= edge.expiresAt) {
                temp[count++] = edge;
            }
        }
        edges = new TrustEdge[](count);
        for (uint256 i = 0; i < count; i++) edges[i] = temp[i];
    }

    /**
     * @notice Returns all agents who have active vouches pointing TO a given agent.
     *         Used by the backend to build D3 trust graph data.
     * @param vouchee The agent being vouched for.
     * @param candidates List of potential vouchers to check (supplied off-chain).
     */
    function getVouchersOf(address vouchee, address[] calldata candidates)
        external
        view
        returns (address[] memory vouchers, uint256[] memory weights)
    {
        address[] memory tempV = new address[](candidates.length);
        uint256[] memory tempW = new uint256[](candidates.length);
        uint256 count = 0;
        for (uint256 i = 0; i < candidates.length; i++) {
            TrustEdge memory edge = trustEdges[candidates[i]][vouchee];
            if (edge.active && block.timestamp <= edge.expiresAt) {
                tempV[count] = candidates[i];
                tempW[count] = edge.weightBps;
                count++;
            }
        }
        vouchers = new address[](count);
        weights  = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            vouchers[i] = tempV[i];
            weights[i]  = tempW[i];
        }
    }

    /// @notice Total active vouch count for an agent.
    function vouchCount(address voucher) external view returns (uint256) {
        return _vouchees[voucher].length;
    }

    function setReputationContract(address _rc) external onlyOwner {
        reputationContract = _rc;
        emit ProtocolAuthorizationUpdated(_rc, true);
    }

    function _removeVouchee(address voucher, address vouchee) internal {
        address[] storage arr = _vouchees[voucher];
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == vouchee) {
                arr[i] = arr[arr.length - 1];
                arr.pop();
                break;
            }
        }
    }
}
