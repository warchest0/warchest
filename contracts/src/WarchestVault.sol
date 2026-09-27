// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3PoolMinimal, IUniswapV3SwapCallback} from "./interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "./interfaces/external/IWETH9.sol";

/// @title WarchestVault
/// @notice Holds the WARCHEST treasury. Receives the native-ETH fees flushed by WarchestHook, converts them to USDG
///         on the deepest on-chain venue under a TWAP-anchored slippage guard, and (S3.2–S3.3) bridges capital to the
///         immutable Hyperliquid account for the trades decided by WarchestGovernance.
/// @dev Trust model (see docs/VAULT.md):
///      - No owner, no upgradability, no function that sends ETH or USDG to an arbitrary address.
///      - `keeper` (bot EOA, replaceable by the guardian) can only trigger conversions bounded by `maxConvertPerCall`,
///        `convertCooldown` and the TWAP floor: a stolen keeper key can at worst sell ETH at
///        `TWAP(twapWindow) × (1 − maxSlippageBps)`, one direction only (there is no USDG → ETH path).
///      - `guardian` (multisig) can pause, rotate the keeper and hand over its own role. It can never move funds.
///      - Anyone can send ETH at any time; {receive} never reverts (the hook's `flush()` depends on it).
///
///      Conversion venue: the Uniswap v3 0.01% WETH/USDG pool, called DIRECTLY (swap + callback) rather than through
///      SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`: one fewer trusted contract, no token approval left
///      dangling, and the callback only pays the pool the exact amount it asks for.
///
///      NAV (USDG, 6 decimals) = USDG balance + ETH balance × TWAP × (1 − maxSlippageBps). ETH is valued at the same
///      floor a conversion is guaranteed to achieve, never at spot, so the NAV a cap is computed from (S3.2) can only
///      be pessimistic. Capital deployed on Hyperliquid is NOT part of `nav()` (see S3.3 accounting).
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

    // ---------------------------------------------------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------------------------------------------------

    uint16 internal constant BPS = 10_000;
    /// @dev Deploy-time sanity bound on `maxSlippageBps` (10%).
    uint16 internal constant MAX_SLIPPAGE_BPS = 1_000;
    /// @dev Transient flag set only for the duration of a pool swap initiated by this contract.
    bytes32 private constant IN_SWAP_SLOT = keccak256("warchest.vault.inSwap");

    IUniswapV3PoolMinimal public immutable pool;
    IWETH9 public immutable weth;
    IERC20 public immutable usdg;
    uint32 public immutable twapWindow;
    uint16 public immutable maxSlippageBps;
    uint256 public immutable maxConvertPerCall;
    uint64 public immutable convertCooldown;

    // ---------------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Multisig: pause, rotate keeper, two-step handover. Never moves funds (D9).
    address public guardian;
    address public pendingGuardian;
    /// @notice Bot EOA with minimal powers. Assumed compromisable.
    address public keeper;
    /// @notice Emergency stop for every keeper action. Never blocks {receive}.
    bool public paused;

    // ---------------------------------------------------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Timestamp of the last conversion (cooldown anchor).
    uint64 public lastConvertAt;
    /// @notice USDG the vault has accounted for through its own operations (conversions in, orders out, ...).
    ///         `usdg.balanceOf(vault) − usdgLedger` is the USDG that arrived from outside (bridge returns, donations),
    ///         which S3.3 attributes to the position being closed. Always ≤ the real balance.
    uint256 public usdgLedger;

    // ---------------------------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------------------------

    event EthReceived(address indexed from, uint256 amount);
    event EthConverted(uint256 ethIn, uint256 usdgOut, uint256 twapFloor);
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

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    constructor(address guardian_, address keeper_, Venue memory venue, ConversionParams memory cp) {
        if (
            guardian_ == address(0) || keeper_ == address(0) || address(venue.pool) == address(0)
                || address(venue.weth) == address(0) || address(venue.usdg) == address(0)
        ) revert ZeroAddress();
        if (venue.pool.token0() != address(venue.weth) || venue.pool.token1() != address(venue.usdg)) {
            revert PoolMismatch();
        }
        if (
            cp.twapWindow == 0 || cp.maxSlippageBps == 0 || cp.maxSlippageBps > MAX_SLIPPAGE_BPS
                || cp.maxConvertPerCall == 0
        ) revert InvalidParams();

        guardian = guardian_;
        keeper = keeper_;
        pool = venue.pool;
        weth = venue.weth;
        usdg = venue.usdg;
        twapWindow = cp.twapWindow;
        maxSlippageBps = cp.maxSlippageBps;
        maxConvertPerCall = cp.maxConvertPerCall;
        convertCooldown = cp.convertCooldown;
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
}
