// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAcrossSpokePool} from "../interfaces/external/IAcrossSpokePool.sol";

/// @title MockAcrossSpokePool
/// @notice Stand-in for the Across SpokePool on networks where Across is not deployed (Robinhood testnet, local E2E —
///         DECISIONS.md D6). Reproduces the checks of the real `deposit` (quote timestamp window, fill deadline
///         buffer, exclusivity rule, ERC20 pull, `depositId = numberOfDeposits++`, `FundsDeposited` event) and holds
///         the deposited tokens. `release` lets the E2E harness hand the tokens to the simulated destination or
///         simulate a refund of an expired deposit. TESTNET ONLY: `release` is permissionless.
contract MockAcrossSpokePool is IAcrossSpokePool {
    using SafeERC20 for IERC20;

    /// @dev Same packing as Across' `DepositV3Params`, which also keeps the real contract under the stack limit.
    struct DepositParams {
        bytes32 depositor;
        bytes32 recipient;
        bytes32 inputToken;
        bytes32 outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 destinationChainId;
        bytes32 exclusiveRelayer;
        uint256 depositId;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    uint32 public constant MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000;

    uint32 public numberOfDeposits;
    uint32 public depositQuoteTimeBuffer = 3600;
    uint32 public fillDeadlineBuffer = 21_600;
    bool public pausedDeposits;

    error InvalidQuoteTimestamp();
    error InvalidFillDeadline();
    error InvalidExclusiveRelayer();
    error InvalidOutputToken();
    error MsgValueDoesNotMatchInputAmount();
    error DepositsArePaused();

    event Released(address indexed token, address indexed to, uint256 amount);

    function setBuffers(uint32 quoteBuffer, uint32 fillBuffer) external {
        depositQuoteTimeBuffer = quoteBuffer;
        fillDeadlineBuffer = fillBuffer;
    }

    function setPausedDeposits(bool p) external {
        pausedDeposits = p;
    }

    function getCurrentTime() public view returns (uint256) {
        return block.timestamp;
    }

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
    ) external payable {
        if (pausedDeposits) revert DepositsArePaused();
        _deposit(
            DepositParams({
                depositor: depositor,
                recipient: recipient,
                inputToken: inputToken,
                outputToken: outputToken,
                inputAmount: inputAmount,
                outputAmount: outputAmount,
                destinationChainId: destinationChainId,
                exclusiveRelayer: exclusiveRelayer,
                depositId: numberOfDeposits++,
                quoteTimestamp: quoteTimestamp,
                fillDeadline: fillDeadline,
                exclusivityParameter: exclusivityParameter,
                message: message
            })
        );
    }

    function _deposit(DepositParams memory p) internal {
        if (p.outputToken == bytes32(0)) revert InvalidOutputToken();
        uint256 currentTime = getCurrentTime();
        if (currentTime < p.quoteTimestamp || currentTime - p.quoteTimestamp > depositQuoteTimeBuffer) {
            revert InvalidQuoteTimestamp();
        }
        if (p.fillDeadline > currentTime + fillDeadlineBuffer) revert InvalidFillDeadline();
        uint32 exclusivityDeadline = p.exclusivityParameter;
        if (exclusivityDeadline > 0) {
            if (exclusivityDeadline <= MAX_EXCLUSIVITY_PERIOD_SECONDS) exclusivityDeadline += uint32(currentTime);
            if (p.exclusiveRelayer == bytes32(0)) revert InvalidExclusiveRelayer();
        }
        if (msg.value != 0) revert MsgValueDoesNotMatchInputAmount();
        IERC20(address(uint160(uint256(p.inputToken)))).safeTransferFrom(msg.sender, address(this), p.inputAmount);

        emit FundsDeposited(
            p.inputToken,
            p.outputToken,
            p.inputAmount,
            p.outputAmount,
            p.destinationChainId,
            p.depositId,
            p.quoteTimestamp,
            p.fillDeadline,
            exclusivityDeadline,
            p.depositor,
            p.recipient,
            p.exclusiveRelayer,
            p.message
        );
    }

    /// @notice E2E helper: moves held tokens to `to` (simulated fill on the destination, or refund to the depositor).
    function release(address token, address to, uint256 amount) external {
        IERC20(token).safeTransfer(to, amount);
        emit Released(token, to, amount);
    }
}
