// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3SwapCallback} from "../../src/interfaces/external/IUniswapV3PoolMinimal.sol";

/// @notice Uniswap v3 pool stand-in: a configurable TWAP tick (oracle) decoupled from a configurable execution
///         tick (the price a swap actually fills at), so tests can simulate sandwiches, stale oracles and partial
///         fills. Exact-input token0 → token1 only, which is all the vault uses.
/// @dev The oracle answers two windows: `twapTick` is the mean over any window ≤ `SHORT_WINDOW` (the vault's
///      `twapWindow`), `longTwapTick` the mean over any longer window (the vault's 6 h circuit-breaker reference).
///      `setTwapTick` moves both (the market moved, the oracle is consistent); `setShortTwapTick` /
///      `setLongTwapTick` move one of them (a held manipulation of the short window).
contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 100;
    uint32 public constant SHORT_WINDOW = 30 minutes;

    int24 public twapTick;
    int24 public longTwapTick;
    int24 public execTick;
    /// Fraction of the requested input the pool actually consumes (10_000 = full fill).
    uint16 public fillBps = 10_000;
    bool public observeReverts;
    bool public rawMode;
    int56 public rawCumulative0;
    int56 public rawCumulative1;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    // --- configuration -------------------------------------------------------------------------------------------

    function setTicks(int24 tick) external {
        twapTick = tick;
        longTwapTick = tick;
        execTick = tick;
    }

    /// Moves the whole oracle (short and long windows agree).
    function setTwapTick(int24 tick) external {
        twapTick = tick;
        longTwapTick = tick;
    }

    function setShortTwapTick(int24 tick) external {
        twapTick = tick;
    }

    function setLongTwapTick(int24 tick) external {
        longTwapTick = tick;
    }

    function setExecTick(int24 tick) external {
        execTick = tick;
    }

    function setFillBps(uint16 bps) external {
        fillBps = bps;
    }

    function setObserveReverts(bool v) external {
        observeReverts = v;
    }

    /// Returns exactly these cumulatives from `observe` (to test rounding of the mean tick).
    function setRawCumulatives(int56 c0, int56 c1) external {
        rawMode = true;
        rawCumulative0 = c0;
        rawCumulative1 = c1;
    }

    // --- pool ABI ------------------------------------------------------------------------------------------------

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtPriceAtTick(execTick), execTick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory) {
        if (observeReverts) revert("OLD");
        int56[] memory cum = new int56[](secondsAgos.length);
        uint160[] memory spl = new uint160[](secondsAgos.length);
        if (rawMode) {
            cum[0] = rawCumulative0;
            cum[1] = rawCumulative1;
            return (cum, spl);
        }
        // cumulative(now) is the same anchor for every entry; the slope over the last `secondsAgo` seconds is the
        // mean tick the vault will compute for that window
        int56 anchor = int56(twapTick) * int56(int256(block.timestamp));
        for (uint256 i; i < secondsAgos.length; ++i) {
            int24 mean = secondsAgos[i] <= SHORT_WINDOW ? twapTick : longTwapTick;
            cum[i] = anchor - int56(mean) * int56(uint56(secondsAgos[i]));
        }
        return (cum, spl);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(zeroForOne && amountSpecified > 0, "mock: exactIn 0->1 only");
        uint256 spent = uint256(amountSpecified) * fillBps / 10_000;
        uint256 out = quote(execTick, spent);
        amount0 = int256(spent);
        amount1 = -int256(out);
        // v3 pays the output first, then asks for the input in the callback
        require(IERC20(token1).transfer(recipient, out), "mock: transfer out");
        uint256 before = IERC20(token0).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(token0).balanceOf(address(this)) >= before + spent, "IIA");
    }

    /// Calls the swap callback of `target` outside any swap (attack simulation).
    function pokeCallback(address target, int256 amount0Delta) external {
        IUniswapV3SwapCallback(target).uniswapV3SwapCallback(amount0Delta, 0, "");
    }

    /// token0 → token1 at `tick` (Uniswap OracleLibrary.getQuoteAtTick).
    function quote(int24 tick, uint256 amount0) public pure returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            return Math.mulDiv(amount0, uint256(sqrtPriceX96) * sqrtPriceX96, uint256(1) << 192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, uint256(1) << 64);
        return Math.mulDiv(amount0, ratioX128, uint256(1) << 128);
    }
}
