// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAcrossSpokePool
/// @notice The subset of the Across V3 SpokePool ABI used by WarchestVault. Matches `contracts/spoke-pools/SpokePool.sol`
///         of across-protocol/contracts (master, 2026-09-27); every selector below was found in the bytecode of the
///         Robinhood Chain SpokePool implementation (`0xD29C85F15DF544bA632C9E25829fd29d767d7978` → EIP-1967 impl
///         `0x1771c470d41b8c39338450c380bf2c080a2cedd8`) and the deposit is exercised on a mainnet fork.
/// @dev Semantics of `deposit` (from the verified source):
///      - `quoteTimestamp` must satisfy `currentTime − depositQuoteTimeBuffer ≤ quoteTimestamp ≤ currentTime`;
///      - `fillDeadline ≤ currentTime + fillDeadlineBuffer` (no lower bound: an already-expired deadline yields an
///        unfillable deposit that is refunded to `depositor` on this chain);
///      - `exclusivityParameter == 0` ⇒ no exclusive relayer, no re-org sensitivity;
///      - an ERC20 `inputToken` is pulled with `safeTransferFrom(msg.sender, spokePool, inputAmount)`, `msg.value` must be 0;
///      - `depositId = numberOfDeposits++`, emitted in `FundsDeposited`.
interface IAcrossSpokePool {
    event FundsDeposited(
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 indexed destinationChainId,
        uint256 indexed depositId,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes32 indexed depositor,
        bytes32 recipient,
        bytes32 exclusiveRelayer,
        bytes message
    );

    function deposit(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32 exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;

    function numberOfDeposits() external view returns (uint32);
    function depositQuoteTimeBuffer() external view returns (uint32);
    function fillDeadlineBuffer() external view returns (uint32);
    function getCurrentTime() external view returns (uint256);
}
