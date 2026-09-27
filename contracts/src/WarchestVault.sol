// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IWarchestDecisionSource} from "./interfaces/IWarchestDecisionSource.sol";
import {WarchestGovernance} from "./WarchestGovernance.sol";
import {IUniswapV3PoolMinimal, IUniswapV3SwapCallback} from "./interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "./interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "./interfaces/external/IAcrossSpokePool.sol";

/// @title IWarchestRoundSource
/// @notice Round end time of a decision, read from governance to judge the staleness of a decision.
interface IWarchestRoundSource {
    function getRound(uint256 roundId) external view returns (WarchestGovernance.Round memory);
}

/// @title WarchestVault
/// @notice Holds the WARCHEST treasury. Receives the native-ETH fees flushed by WarchestHook, converts them to USDG
///         on the deepest on-chain venue under a TWAP-anchored slippage guard, and bridges capital through Across to
///         the immutable Hyperliquid account for the trades decided by WarchestGovernance (S3.3: reports, PnL, HWM).
/// @dev Trust model (see docs/VAULT.md):
///      - No owner, no upgradability, no function that sends ETH or USDG to an arbitrary address. USDG can only leave
///        towards the Across SpokePool, and only for the immutable `bridgeRecipient` on `destinationChainId`.
///      - `keeper` (bot EOA, replaceable by the guardian) can only (1) trigger conversions bounded by
///        `maxConvertPerCall`, `convertCooldown` and the TWAP floor, and (2) execute the current governance decision
///        at most once, with at most `capBps` of the NAV, at most one open position at a time, with a bridge fee
///        bounded by `maxBridgeFeeBps`. A stolen keeper key can at worst sell ETH at
///        `TWAP × (1 − maxSlippageBps)` and bridge ≤ cap to the Hyperliquid account once per governance decision.
///      - `guardian` (multisig) can pause, rotate the keeper and hand over its own role. It can never move funds,
///        change the recipient or the caps.
///      - Anyone can send ETH at any time; {receive} never reverts (the hook's `flush()` depends on it).
///
///      Conversion venue: the Uniswap v3 0.01% WETH/USDG pool, called DIRECTLY (swap + callback) rather than through
///      SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`: one fewer trusted contract, no token approval left
///      dangling, and the callback only pays the pool the exact amount it asks for.
///
///      NAV (USDG, 6 decimals) = USDG balance + ETH balance × TWAP × (1 − maxSlippageBps). ETH is valued at the same
///      floor a conversion is guaranteed to achieve, never at spot, so the NAV the cap is computed from can only be
///      pessimistic. Capital deployed on Hyperliquid is NOT part of `nav()`: an order can only be executed while no
///      position is open, so the cap is always measured against liquid assets only.
///
///      Stop-loss / take-profit cannot be enforced from Robinhood Chain (RESEARCH.md §2.5): the immutable risk
///      parameters are published here and emitted with every order; the keeper must apply them as Hyperliquid
///      trigger orders, and an independent monitor must check that it did.
contract WarchestVault is IUniswapV3SwapCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TransientSlot for *;

    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice External contracts of the conversion venue, all immutable.
    struct Venue {
        /// Uniswap v3 WETH/USDG pool: `token0` MUST be `weth` and `token1` MUST be `usdg` (checked at construction).
        IUniswapV3PoolMinimal pool;
        IWETH9 weth;
        IERC20 usdg;
    }

    /// @notice Immutable bounds of {convertEthToUsdg}.
    struct ConversionParams {
        /// TWAP window in seconds read from the pool oracle (30 min recommended; the pool keeps ≈ 44 h of history).
        uint32 twapWindow;
        /// Max discount vs the TWAP a conversion may accept, in bps. Also the haircut applied to ETH in {nav}.
        uint16 maxSlippageBps;
        /// Max ETH (wei) converted per call.
        uint256 maxConvertPerCall;
        /// Min delay between two conversions, so the guardian can react to a misbehaving keeper.
        uint64 convertCooldown;
    }

    /// @notice Immutable bridge route (DECISIONS.md D5): USDG on Robinhood Chain → USDC on HyperEVM (999), to the
    ///         Hyperliquid account. The recipient can NEVER be changed.
    struct Bridge {
        IAcrossSpokePool spokePool;
        /// Hyperliquid account (multisig, D4) receiving the USDC on `destinationChainId`.
        address recipient;
        /// Output token on the destination chain (USDC on HyperEVM).
        address outputToken;
        uint256 destinationChainId;
    }

    /// @notice Immutable order bounds and published risk parameters.
    struct OrderParams {
        /// Max capital per order, in bps of {nav}. Hard-bounded by `MAX_CAP_BPS` (20%).
        uint16 capBps;
        /// Max bridge fee accepted: `outputAmount ≥ amount × (1 − maxBridgeFeeBps)`.
        uint16 maxBridgeFeeBps;
        /// A decision whose round ended more than this long ago cannot be executed anymore.
        uint64 maxDecisionAge;
        /// Stop-loss distance the keeper must set on Hyperliquid, in bps of the entry price.
        uint16 stopLossBps;
        /// Leverage the keeper must use on Hyperliquid (isolated margin).
        uint8 leverage;
        /// Profit (bps of capital) above which a close vote may be opened (S3.3).
        uint16 takeProfitBps;
    }

    /// @notice The single position the treasury may have open.
    struct Position {
        /// 0 = no position.
        uint256 decisionId;
        uint32 asset;
        IWarchestDecisionSource.Side side;
        /// USDG bridged out for this position.
        uint256 capital;
        uint64 openedAt;
        /// Across deposit id of the outbound transfer.
        uint256 depositId;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------------------------------------------------

    uint16 internal constant BPS = 10_000;
    /// @dev Deploy-time sanity bound on `maxSlippageBps` (10%).
    uint16 internal constant MAX_SLIPPAGE_BPS = 1_000;
    /// @notice Hard cap: no deployment may allow more than 20% of the NAV per order.
    uint16 public constant MAX_CAP_BPS = 2_000;
    /// @dev Deploy-time sanity bound on `maxBridgeFeeBps` (5%).
    uint16 internal constant MAX_BRIDGE_FEE_BPS = 500;
    /// @dev Transient flag set only for the duration of a pool swap initiated by this contract.
    bytes32 private constant IN_SWAP_SLOT = keccak256("warchest.vault.inSwap");

    IWarchestDecisionSource public immutable governance;
    IUniswapV3PoolMinimal public immutable pool;
    IWETH9 public immutable weth;
    IERC20 public immutable usdg;
    uint32 public immutable twapWindow;
    uint16 public immutable maxSlippageBps;
    uint256 public immutable maxConvertPerCall;
    uint64 public immutable convertCooldown;

    IAcrossSpokePool public immutable spokePool;
    address public immutable bridgeRecipient;
    address public immutable bridgeOutputToken;
    uint256 public immutable destinationChainId;
    uint16 public immutable capBps;
    uint16 public immutable maxBridgeFeeBps;
    uint64 public immutable maxDecisionAge;
    uint16 public immutable stopLossBps;
    uint8 public immutable leverage;
    uint16 public immutable takeProfitBps;

    // ---------------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Multisig: pause, rotate keeper, two-step handover. Never moves funds (D9).
    address public guardian;
    address public pendingGuardian;
    /// @notice Bot EOA with minimal powers. Assumed compromisable.
    address public keeper;
    /// @notice Emergency stop for every keeper action. Never blocks {receive}. Also tells the keeper to unwind
    ///         the open position ({mustClose}).
    bool public paused;

    // ---------------------------------------------------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Timestamp of the last conversion (cooldown anchor).
    uint64 public lastConvertAt;
    /// @notice USDG the vault has accounted for through its own operations (conversions in, orders out).
    ///         `usdg.balanceOf(vault) − usdgLedger` is the USDG that arrived from outside (bridge returns, refunds of
    ///         expired deposits, donations), which S3.3 attributes to the position being closed. Always ≤ balance.
    uint256 public usdgLedger;
    /// @notice Highest decision id ever executed. Ids are monotonic in governance, so "id ≤ last" ⇔ already
    ///         executed (or older than one that was): each decision runs AT MOST ONCE (D8).
    uint256 public lastExecutedDecisionId;
    Position internal _position;

    // ---------------------------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------------------------

    event EthReceived(address indexed from, uint256 amount);
    event EthConverted(uint256 ethIn, uint256 usdgOut, uint256 twapFloor);
    /// @notice Everything the keeper and the indexer need: what to open on Hyperliquid and with which risk params.
    ///         (`quoteTimestamp` and `fillDeadline` are in the SpokePool's `FundsDeposited` event of the same tx.)
    event OrderExecuted(
        uint256 indexed decisionId,
        uint32 indexed asset,
        IWarchestDecisionSource.Side side,
        uint256 capital,
        uint256 outputAmount,
        uint256 depositId,
        uint16 stopLossBps,
        uint8 leverage,
        uint16 takeProfitBps
    );
    event GuardianTransferStarted(address indexed current, address indexed pending);
    event GuardianChanged(address indexed previous, address indexed current);
    event KeeperChanged(address indexed previous, address indexed current);
    event Paused(bool paused);

    error ZeroAddress();
    error NotGuardian();
    error NotPendingGuardian();
    error NotKeeper();
    error IsPaused();
    error InvalidParams();
    error PoolMismatch();
    error AmountOutOfRange(uint256 amount, uint256 max);
    error InsufficientEth(uint256 requested, uint256 balance);
    error ConvertCooldown(uint256 nextAllowedAt);
    error MinOutBelowFloor(uint256 minOut, uint256 floor);
    error InsufficientOutput(uint256 received, uint256 minOut);
    error PartialFill(uint256 spent, uint256 requested);
    error UnexpectedCallback();
    error NoDecision();
    error DecisionAlreadyExecuted(uint256 decisionId, uint256 lastExecuted);
    error DecisionStale(uint256 decisionId, uint256 roundEndsAt);
    error PositionOpen(uint256 decisionId);
    error CapExceeded(uint256 amount, uint256 maxAmount);
    error LedgerInsufficient(uint256 amount, uint256 ledger);
    error BridgeFeeTooHigh(uint256 outputAmount, uint256 minOutput);
    error InvalidOutputAmount(uint256 outputAmount, uint256 amount);
    error InvalidFillDeadline(uint32 fillDeadline);
    error BridgeAmountMismatch(uint256 expected, uint256 actual);

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    constructor(
        address guardian_,
        address keeper_,
        IWarchestDecisionSource governance_,
        Venue memory venue,
        Bridge memory bridge,
        ConversionParams memory cp,
        OrderParams memory op
    ) {
        if (
            guardian_ == address(0) || keeper_ == address(0) || address(governance_) == address(0)
                || address(venue.pool) == address(0) || address(venue.weth) == address(0)
                || address(venue.usdg) == address(0) || address(bridge.spokePool) == address(0)
                || bridge.recipient == address(0) || bridge.outputToken == address(0)
        ) revert ZeroAddress();
        if (venue.pool.token0() != address(venue.weth) || venue.pool.token1() != address(venue.usdg)) {
            revert PoolMismatch();
        }
        if (
            cp.twapWindow == 0 || cp.maxSlippageBps == 0 || cp.maxSlippageBps > MAX_SLIPPAGE_BPS
                || cp.maxConvertPerCall == 0
        ) revert InvalidParams();
        if (
            bridge.destinationChainId == 0 || op.capBps == 0 || op.capBps > MAX_CAP_BPS
                || op.maxBridgeFeeBps > MAX_BRIDGE_FEE_BPS || op.maxDecisionAge == 0 || op.stopLossBps == 0
                || op.stopLossBps >= BPS || op.leverage == 0 || op.takeProfitBps == 0
        ) revert InvalidParams();

        guardian = guardian_;
        keeper = keeper_;
        governance = governance_;
        pool = venue.pool;
        weth = venue.weth;
        usdg = venue.usdg;
        spokePool = bridge.spokePool;
        bridgeRecipient = bridge.recipient;
        bridgeOutputToken = bridge.outputToken;
        destinationChainId = bridge.destinationChainId;
        twapWindow = cp.twapWindow;
        maxSlippageBps = cp.maxSlippageBps;
        maxConvertPerCall = cp.maxConvertPerCall;
        convertCooldown = cp.convertCooldown;
        capBps = op.capBps;
        maxBridgeFeeBps = op.maxBridgeFeeBps;
        maxDecisionAge = op.maxDecisionAge;
        stopLossBps = op.stopLossBps;
        leverage = op.leverage;
        takeProfitBps = op.takeProfitBps;
        emit GuardianChanged(address(0), guardian_);
        emit KeeperChanged(address(0), keeper_);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Custody
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Accepts native ETH from anyone, at any time, paused or not. Never reverts: WarchestHook.flush() and
    ///         WETH.withdraw() both rely on it.
    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyGuardian {
        if (keeper_ == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, keeper_);
        keeper = keeper_;
    }

    function transferGuardian(address pending) external onlyGuardian {
        pendingGuardian = pending;
        emit GuardianTransferStarted(guardian, pending);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotPendingGuardian();
        emit GuardianChanged(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    function setPaused(bool paused_) external onlyGuardian {
        paused = paused_;
        emit Paused(paused_);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // ETH → USDG conversion
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Sells `amountIn` wei of ETH for USDG on the immutable pool. Keeper only.
    /// @dev On-chain guard against a compromised keeper: `minOut` must be at least {twapFloor}(amountIn), i.e. the
    ///      `twapWindow` TWAP of the pool minus `maxSlippageBps`, and the swap reverts if it delivers less than
    ///      `minOut`. Together with `maxConvertPerCall` and `convertCooldown` this bounds the damage of any sequence
    ///      of malicious calls to `maxSlippageBps` of the ETH converted, at a rate the guardian can interrupt.
    ///      The swap is exact-input with the extreme price limit; a partial fill (pool liquidity exhausted) reverts.
    /// @param amountIn ETH to sell, in wei. Must be ≤ `maxConvertPerCall` and ≤ the vault's ETH balance.
    /// @param minOut Minimum USDG (6 decimals) to receive; must be ≥ {twapFloor}(amountIn).
    /// @return amountOut USDG received.
    function convertEthToUsdg(uint256 amountIn, uint256 minOut)
        external
        onlyKeeper
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || amountIn > maxConvertPerCall) {
            revert AmountOutOfRange(amountIn, maxConvertPerCall);
        }
        uint256 ethBalance = address(this).balance;
        if (amountIn > ethBalance) revert InsufficientEth(amountIn, ethBalance);
        uint256 nextAllowedAt = uint256(lastConvertAt) + convertCooldown;
        if (block.timestamp < nextAllowedAt) revert ConvertCooldown(nextAllowedAt);
        uint256 floor = twapFloor(amountIn);
        if (minOut < floor) revert MinOutBelowFloor(minOut, floor);
        lastConvertAt = uint64(block.timestamp);

        weth.deposit{value: amountIn}();
        uint256 usdgBefore = usdg.balanceOf(address(this));

        IN_SWAP_SLOT.asBoolean().tstore(true);
        (int256 amount0,) = pool.swap(address(this), true, int256(amountIn), TickMath.MIN_SQRT_PRICE + 1, new bytes(0));
        IN_SWAP_SLOT.asBoolean().tstore(false);

        amountOut = usdg.balanceOf(address(this)) - usdgBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        if (amount0 != int256(amountIn)) revert PartialFill(amount0 > 0 ? uint256(amount0) : 0, amountIn);

        usdgLedger += amountOut;
        emit EthConverted(amountIn, amountOut, floor);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    /// @dev Only the immutable pool may call this, and only during a swap this contract started. Pays exactly what
    ///      the pool asks for in WETH; the pool can never ask for more than the exact input.
    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        if (msg.sender != address(pool) || !IN_SWAP_SLOT.asBoolean().tload()) revert UnexpectedCallback();
        if (amount0Delta > 0) IERC20(address(weth)).safeTransfer(address(pool), uint256(amount0Delta));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Order execution (S3.2)
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Executes the current governance decision: bridges `amount` USDG through Across to the immutable
    ///         Hyperliquid account and records the position. Keeper only, at most once per decision id, only while
    ///         no position is open, only for `amount ≤ capBps × nav()`.
    /// @dev Everything about the bridge deposit except `amount`, `outputAmount`, `quoteTimestamp` and
    ///      `fillDeadline` is hard-coded: depositor = this vault (so an expired deposit is refunded HERE),
    ///      recipient / output token / destination chain are immutable, no exclusive relayer, empty message.
    ///      `outputAmount` (USDC, 6 decimals, like USDG) is bounded below by `maxBridgeFeeBps` and above by `amount`.
    ///      The SpokePool itself validates `quoteTimestamp` (≤ 1 h old) and `fillDeadline` (≤ 6 h ahead).
    ///      The USDG actually pulled by the SpokePool is verified to equal `amount`.
    /// @param amount USDG (6 decimals) to bridge. Must be ≤ {maxOrderAmount} and ≤ {usdgLedger}.
    /// @param outputAmount USDC the Hyperliquid account must receive (from the Across suggested-fees API).
    /// @param quoteTimestamp Across quote timestamp (from the API).
    /// @param fillDeadline Timestamp after which the deposit can no longer be filled (then refunded to the vault).
    function executeDecision(uint256 amount, uint256 outputAmount, uint32 quoteTimestamp, uint32 fillDeadline)
        external
        onlyKeeper
        whenNotPaused
        nonReentrant
    {
        IWarchestDecisionSource.Decision memory d = governance.currentDecision();
        _checkDecision(d);
        _checkOrder(amount, outputAmount, fillDeadline);

        lastExecutedDecisionId = d.id;
        uint256 depositId = spokePool.numberOfDeposits();
        _position = Position({
            decisionId: d.id,
            asset: d.asset,
            side: d.side,
            capital: amount,
            openedAt: uint64(block.timestamp),
            depositId: depositId
        });
        usdgLedger -= amount;
        _bridge(amount, outputAmount, quoteTimestamp, fillDeadline);

        emit OrderExecuted(d.id, d.asset, d.side, amount, outputAmount, depositId, stopLossBps, leverage, takeProfitBps);
    }

    /// @dev New id, no open position, round not stale.
    function _checkDecision(IWarchestDecisionSource.Decision memory d) internal view {
        if (d.id == 0) revert NoDecision();
        if (d.id <= lastExecutedDecisionId) revert DecisionAlreadyExecuted(d.id, lastExecutedDecisionId);
        if (_position.decisionId != 0) revert PositionOpen(_position.decisionId);
        uint256 roundEndsAt = IWarchestRoundSource(address(governance)).getRound(d.roundId).endsAt;
        if (roundEndsAt == 0 || block.timestamp > roundEndsAt + maxDecisionAge) {
            revert DecisionStale(d.id, roundEndsAt);
        }
    }

    /// @dev Cap, ledger, bridge fee bounds, deadline.
    function _checkOrder(uint256 amount, uint256 outputAmount, uint32 fillDeadline) internal view {
        uint256 maxAmount = maxOrderAmount();
        if (amount == 0 || amount > maxAmount) revert CapExceeded(amount, maxAmount);
        if (amount > usdgLedger) revert LedgerInsufficient(amount, usdgLedger);
        uint256 minOutput = amount * (BPS - maxBridgeFeeBps) / BPS;
        if (outputAmount < minOutput) revert BridgeFeeTooHigh(outputAmount, minOutput);
        if (outputAmount > amount) revert InvalidOutputAmount(outputAmount, amount);
        if (fillDeadline <= block.timestamp) revert InvalidFillDeadline(fillDeadline);
    }

    /// @dev Across deposit with every field but the four bounded ones hard-coded; verifies the SpokePool pulled
    ///      exactly `amount` and left no allowance behind.
    function _bridge(uint256 amount, uint256 outputAmount, uint32 quoteTimestamp, uint32 fillDeadline) internal {
        uint256 balanceBefore = usdg.balanceOf(address(this));
        usdg.forceApprove(address(spokePool), amount);
        spokePool.deposit(
            _toBytes32(address(this)),
            _toBytes32(bridgeRecipient),
            _toBytes32(address(usdg)),
            _toBytes32(bridgeOutputToken),
            amount,
            outputAmount,
            destinationChainId,
            bytes32(0),
            quoteTimestamp,
            fillDeadline,
            0,
            new bytes(0)
        );
        uint256 pulled = balanceBefore - usdg.balanceOf(address(this));
        if (pulled != amount || usdg.allowance(address(this), address(spokePool)) != 0) {
            revert BridgeAmountMismatch(amount, pulled);
        }
    }

    /// @notice The position currently open (decisionId 0 = none).
    function position() external view returns (Position memory) {
        return _position;
    }

    /// @notice Max USDG an order may bridge right now: `capBps` of {nav}.
    function maxOrderAmount() public view returns (uint256) {
        return nav() * capBps / BPS;
    }

    /// @notice True when the keeper MUST close the open position on Hyperliquid and bring the funds back:
    ///         governance requested the close (unconditionally, no profit re-check), governance minted a newer
    ///         decision (the position is superseded, even if the new decision has the same asset and side), or the
    ///         guardian paused the vault.
    function mustClose() public view returns (bool) {
        uint256 id = _position.decisionId;
        if (id == 0) return false;
        return paused || governance.isCloseRequested(id) || governance.currentDecision().id > id;
    }

    /// @notice Risk parameters the keeper must apply on Hyperliquid for every position.
    function riskParams() external view returns (uint16 stopLoss, uint8 lev, uint16 takeProfit) {
        return (stopLossBps, leverage, takeProfitBps);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Oracle & NAV
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Arithmetic-mean tick of the pool over the last `twapWindow` seconds (Uniswap OracleLibrary semantics:
    ///         rounds toward negative infinity). Reverts "OLD" if the pool history is shorter than the window.
    function twapTick() public view returns (int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory cumulatives,) = pool.observe(secondsAgos);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 window = int56(uint56(twapWindow));
        tick = int24(delta / window);
        if (delta < 0 && (delta % window != 0)) tick--;
    }

    /// @notice USDG value of `ethAmount` wei at the TWAP price (no haircut).
    function quoteEthInUsdg(uint256 ethAmount) public view returns (uint256) {
        return quoteAtTick(twapTick(), ethAmount);
    }

    /// @notice USDG a conversion of `ethAmount` must at least return: TWAP value × (1 − maxSlippageBps).
    function twapFloor(uint256 ethAmount) public view returns (uint256) {
        return quoteEthInUsdg(ethAmount) * (BPS - maxSlippageBps) / BPS;
    }

    /// @notice Liquid net asset value in USDG (6 decimals): USDG balance + ETH balance valued at {twapFloor}.
    /// @dev Conservative by construction: ETH is counted at the worst price a conversion may accept. Capital that is
    ///      away on Hyperliquid is not included.
    function nav() public view returns (uint256) {
        return usdg.balanceOf(address(this)) + twapFloor(address(this).balance);
    }

    /// @notice token0 → token1 quote at `tick` (same math as Uniswap's OracleLibrary.getQuoteAtTick).
    function quoteAtTick(int24 tick, uint256 amount0) public pure returns (uint256 amount1) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            amount1 = Math.mulDiv(amount0, ratioX192, uint256(1) << 192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, uint256(1) << 64);
            amount1 = Math.mulDiv(amount0, ratioX128, uint256(1) << 128);
        }
    }

    function _toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
