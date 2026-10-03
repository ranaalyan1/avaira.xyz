// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFreezeSlash {
    function setProtocolAuthorized(address actor, bool authorized) external;
    function freezeAndSlash(address agent, uint256 slashAmount, string calldata reason) external returns (uint256);
}
