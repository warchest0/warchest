// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHookEvents} from "@openzeppelin/uniswap-hooks/interfaces/IHookEvents.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {WarchestHookFixture, MockVault} from "./utils/WarchestHookFixture.sol";

/// @notice S1.3: exactOut cases (fee = net / 9), partial fills and price limits, zero liquidity, multi-tick
///         crossings, extreme amounts, and fuzzing of the 10% bound in all four cases.
contract WarchestHookExactOutTest is WarchestHookFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MockVault vault;

    function setUp() public {
        deployFreshManagerAndRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e30);
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);
    }

    /// @dev 0 <= fee - gross/10 < 1 wei  <=>  gross <= 10*fee < gross + 10
    function _assertTenPercent(uint256 fee, uint256 gross) internal pure {
        assertGe(fee * 10, gross, "fee below 10% of gross");
        assertLt(fee * 10, gross + 10, "fee more than 1 wei above 10% of gross");
    }

    // =========================================================================================== BUY exactOut

    function test_buyExactOut_feeIsTenPercentOfGrossEthPaid() public {
        uint256 t = 1000 ether;
        BalanceDelta r = _buyExactOut(refKey, t, 5_000 ether);
        uint256 p = uint256(-int256(r.amount0()));
        uint256 fee = _feeOnNet(p);

        uint256 ethBefore = address(this).balance;
        vm.expectEmit(true, true, true, true, address(hook));
        emit IHookEvents.HookFee(PoolId.unwrap(hookedId), address(swapRouter), uint128(fee), 0);
        BalanceDelta d = _buyExactOut(hookedKey, t, 5_000 ether);

        assertEq(d.amount1(), int256(t), "exact token output");
        assertEq(d.amount0(), -int256(p + fee), "user pays P + fee");
        assertEq(ethBefore - address(this).balance, p + fee, "surplus refunded, net cost P + fee");
        assertEq(hook.pendingFees(), fee);
        _assertTenPercent(fee, p + fee);
        assertEq(_sqrtPrice(hookedKey), _sqrtPrice(refKey), "pool state identical to reference");
    }

    function testFuzz_buyExactOut_feeWithinOneWeiOf10Percent(uint256 t) public {
        t = bound(t, 1, 5_000 ether);
        BalanceDelta r = _buyExactOut(refKey, t, 1e29);
        uint256 p = uint256(-int256(r.amount0()));
        BalanceDelta d = _buyExactOut(hookedKey, t, 1e29);
        uint256 fee = hook.pendingFees();
        assertEq(d.amount1(), int256(t));
        assertEq(uint256(-int256(d.amount0())), p + fee, "user pays exactly P + fee");
        _assertTenPercent(fee, p + fee);
    }

    // =========================================================================================== SELL exactOut

    function test_sellExactOut_feeIsTenPercentOfGrossEthPaidByPool() public {
        uint256 x = 1 ether;
        uint256 fee = _feeOnNet(x); // the pool must pay X + fee, fee == 10% of that
        // reference: a hook-less pool paying X + fee costs the same tokens
        BalanceDelta r = _sellExactOut(refKey, x + fee);

        uint256 ethBefore = address(this).balance;
        vm.expectEmit(true, true, true, true, address(hook));
        emit IHookEvents.HookFee(PoolId.unwrap(hookedId), address(swapRouter), uint128(fee), 0);
        BalanceDelta d = _sellExactOut(hookedKey, x);

        assertEq(d.amount0(), int256(x), "user receives exactly X net");
        assertEq(d.amount1(), r.amount1(), "same token cost as reference paying X + fee");
        assertEq(address(this).balance - ethBefore, x);
        assertEq(hook.pendingFees(), fee);
        _assertTenPercent(fee, x + fee);
        assertEq(_sqrtPrice(hookedKey), _sqrtPrice(refKey));
    }

    function testFuzz_sellExactOut_feeWithinOneWeiOf10Percent(uint256 x) public {
        x = bound(x, 1, 5_000 ether);
        BalanceDelta d = _sellExactOut(hookedKey, x);
        uint256 fee = hook.pendingFees();
        assertEq(d.amount0(), int256(x));
        _assertTenPercent(fee, x + fee);
        BalanceDelta r = _sellExactOut(refKey, x + fee);
        assertEq(d.amount1(), r.amount1());
    }

    // =========================================================================================== all four, fuzz

    /// @dev One fuzz run exercising the four cases in sequence on the same pool; every fee is within 1 wei of 10%.
    function testFuzz_allFourCases_feeBound(uint256 a, uint256 b, uint256 c, uint256 e) public {
        a = bound(a, 1, 1_000 ether);
        b = bound(b, 1, 1_000 ether);
        c = bound(c, 1, 1_000 ether);
        e = bound(e, 1, 500 ether);

        uint256 before = hook.pendingFees();
        BalanceDelta d = _buyExactIn(hookedKey, a);
        uint256 fee = hook.pendingFees() - before;
        _assertTenPercent(fee, uint256(-int256(d.amount0())));

        before = hook.pendingFees();
        d = _buyExactOut(hookedKey, b, 1e29);
        fee = hook.pendingFees() - before;
        _assertTenPercent(fee, uint256(-int256(d.amount0())));

        before = hook.pendingFees();
        d = _sellExactIn(hookedKey, c);
        fee = hook.pendingFees() - before;
        _assertTenPercent(fee, uint256(int256(d.amount0())) + fee);

        before = hook.pendingFees();
        d = _sellExactOut(hookedKey, e);
        fee = hook.pendingFees() - before;
        _assertTenPercent(fee, uint256(int256(d.amount0())) + fee);
    }

    // =========================================================================================== partial fills

    function test_sellExactOut_priceLimit_revertsPartialFill() public {
        uint160 limit = _sqrtPrice(hookedKey) * 1001 / 1000;
        try swapRouter.swap(
            hookedKey, SwapParams(false, 100 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
        assertEq(hook.pendingFees(), 0);
        // the hook-less pool happily partially fills the same request
        BalanceDelta r =
            swapRouter.swap(refKey, SwapParams(false, 100 ether, limit), PoolSwapTest.TestSettings(false, false), "");
        assertLt(uint256(int256(r.amount0())), 100 ether);
    }

    /// @dev A pool whose only liquidity is a narrow range: swapping past it leaves the request partially filled.
    function _narrowPool() internal returns (PoolKey memory k, WarchestHook h) {
        (k, h) = _emptyPool();
        _addLiquidity(k, -600, 600, 1_000 ether, 1_000 ether); // ~30 ETH and ~30 WAR
    }

    function test_sellExactOut_insufficientLiquidity_revertsPartialFill() public {
        (PoolKey memory k,) = _narrowPool();
        try swapRouter.swap(
            k, SwapParams(false, 100 ether, MAX_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
        // a smaller request that the range can serve goes through
        BalanceDelta d = _sellExactOut(k, 1 ether);
        assertEq(d.amount0(), 1 ether);
    }

    function test_buyExactIn_insufficientLiquidity_revertsPartialFill() public {
        (PoolKey memory k, WarchestHook h) = _narrowPool();
        try swapRouter.swap{value: 100 ether}(
            k, SwapParams(true, -100 ether, MIN_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
        assertEq(h.pendingFees(), 0);
        BalanceDelta d = _buyExactIn(k, 1 ether);
        assertEq(d.amount0(), -1 ether);
        assertEq(h.pendingFees(), 0.1 ether);
    }

    function test_afterSwapCases_insufficientLiquidity_partialFillCharged() public {
        (PoolKey memory k, WarchestHook h) = _narrowPool();
        // BUY exactOut asking more WAR than the range holds: partially filled, fee on the realised ETH
        BalanceDelta d = _buyExactOut(k, 100 ether, 1_000 ether);
        assertLt(uint256(int256(d.amount1())), 100 ether, "partially filled");
        uint256 fee = h.pendingFees();
        _assertTenPercent(fee, uint256(-int256(d.amount0())));
        // SELL exactIn more WAR than can be absorbed before the range ends
        uint256 before = h.pendingFees();
        d = _sellExactIn(k, 1_000 ether);
        assertLt(uint256(-int256(d.amount1())), 1_000 ether, "input only partially consumed");
        fee = h.pendingFees() - before;
        _assertTenPercent(fee, uint256(int256(d.amount0())) + fee);
    }

    function test_buyExactOut_priceLimit_partialFillAllowedAndChargedOnRealised() public {
        // BUY exactOut: fee is computed in afterSwap on the realised ETH => partial fill is fine
        uint160 limit = _sqrtPrice(hookedKey) * 999 / 1000;
        BalanceDelta r = swapRouter.swap{value: 1000 ether}(
            refKey, SwapParams(true, 1000 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 p = uint256(-int256(r.amount0()));
        assertLt(uint256(int256(r.amount1())), 1000 ether, "reference is partially filled");

        BalanceDelta d = swapRouter.swap{value: 1000 ether}(
            hookedKey, SwapParams(true, 1000 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 fee = hook.pendingFees();
        assertEq(d.amount1(), r.amount1(), "same partial token output as reference");
        assertEq(uint256(-int256(d.amount0())), p + fee);
        _assertTenPercent(fee, p + fee);
    }

    function test_sellExactIn_priceLimit_partialFillAllowedAndChargedOnRealised() public {
        uint160 limit = _sqrtPrice(hookedKey) * 1001 / 1000;
        BalanceDelta r =
            swapRouter.swap(refKey, SwapParams(false, -1000 ether, limit), PoolSwapTest.TestSettings(false, false), "");
        uint256 g = uint256(int256(r.amount0()));
        assertGt(uint256(-int256(r.amount1())), 0);
        assertLt(uint256(-int256(r.amount1())), 1000 ether, "reference consumed only part of the input");

        BalanceDelta d = swapRouter.swap(
            hookedKey, SwapParams(false, -1000 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 fee = hook.pendingFees();
        assertEq(d.amount1(), r.amount1(), "same partial token input as reference");
        assertEq(uint256(int256(d.amount0())), g - fee);
        _assertTenPercent(fee, g);
    }

    // =========================================================================================== zero liquidity

    function _emptyPool() internal returns (PoolKey memory k, WarchestHook h) {
        h = _deployHook(address(token), address(vault), address(this));
        k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LP_FEE, TICK_SPACING, h);
        manager.initialize(k, SQRT_PRICE_1_1);
        hook = h; // for the revert helpers
    }

    function test_zeroLiquidity_buyExactIn_revertsPartialFill() public {
        (PoolKey memory k,) = _emptyPool();
        try swapRouter.swap{value: 1 ether}(
            k, SwapParams(true, -1 ether, MIN_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
    }

    function test_zeroLiquidity_sellExactOut_revertsPartialFill() public {
        (PoolKey memory k,) = _emptyPool();
        try swapRouter.swap(
            k, SwapParams(false, 1 ether, MAX_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
    }

    function test_zeroLiquidity_afterSwapCases_chargeNothing() public {
        (PoolKey memory k, WarchestHook h) = _emptyPool();
        // SELL exactIn: nothing is output, nothing is charged, and no token leaves the seller
        uint256 tokBefore = token.balanceOf(address(this));
        BalanceDelta d = _sellExactIn(k, 1 ether);
        assertEq(d.amount0(), 0);
        assertEq(d.amount1(), 0);
        assertEq(token.balanceOf(address(this)), tokBefore);
        // BUY exactOut: nothing is delivered, nothing is paid
        uint256 ethBefore = address(this).balance;
        d = _buyExactOut(k, 1 ether, 10 ether);
        assertEq(d.amount0(), 0);
        assertEq(d.amount1(), 0);
        assertEq(address(this).balance, ethBefore);
        assertEq(h.pendingFees(), 0);
    }

    // =========================================================================================== multi-tick

    function _addConcentratedLiquidityBoth() internal {
        // several initialised ticks on both sides of the current price (tick 0)
        _addLiquidityBoth(-6000, -600, 5_000 ether, 10_000 ether);
        _addLiquidityBoth(-600, -60, 5_000 ether, 10_000 ether);
        _addLiquidityBoth(-60, 60, 5_000 ether, 10_000 ether);
        _addLiquidityBoth(60, 600, 5_000 ether, 10_000 ether);
        _addLiquidityBoth(600, 6000, 5_000 ether, 10_000 ether);
    }

    function _tick(PoolKey memory k) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(k.toId());
    }

    function test_multiTick_buyExactIn() public {
        _addConcentratedLiquidityBoth();
        uint256 x = 2_000 ether;
        uint256 fee = _feeOnGross(x);
        BalanceDelta d = _buyExactIn(hookedKey, x);
        BalanceDelta r = _buyExactIn(refKey, x - fee);
        assertLt(_tick(hookedKey), -600, "crossed several initialised ticks");
        assertEq(d.amount1(), r.amount1());
        assertEq(_tick(hookedKey), _tick(refKey));
        assertEq(hook.pendingFees(), fee);
    }

    function test_multiTick_buyExactOut() public {
        _addConcentratedLiquidityBoth();
        uint256 t = 3_000 ether;
        BalanceDelta r = _buyExactOut(refKey, t, 1e28);
        uint256 p = uint256(-int256(r.amount0()));
        BalanceDelta d = _buyExactOut(hookedKey, t, 1e28);
        assertLt(_tick(hookedKey), -600);
        assertEq(d.amount1(), int256(t));
        uint256 fee = hook.pendingFees();
        assertEq(uint256(-int256(d.amount0())), p + fee);
        _assertTenPercent(fee, p + fee);
        assertEq(_tick(hookedKey), _tick(refKey));
    }

    function test_multiTick_sellExactIn() public {
        _addConcentratedLiquidityBoth();
        uint256 t = 3_000 ether;
        BalanceDelta r = _sellExactIn(refKey, t);
        uint256 g = uint256(int256(r.amount0()));
        BalanceDelta d = _sellExactIn(hookedKey, t);
        assertGt(_tick(hookedKey), 600);
        uint256 fee = hook.pendingFees();
        assertEq(uint256(int256(d.amount0())), g - fee);
        _assertTenPercent(fee, g);
        assertEq(_tick(hookedKey), _tick(refKey));
    }

    function test_multiTick_sellExactOut() public {
        _addConcentratedLiquidityBoth();
        uint256 x = 2_000 ether;
        uint256 fee = _feeOnNet(x);
        BalanceDelta r = _sellExactOut(refKey, x + fee);
        BalanceDelta d = _sellExactOut(hookedKey, x);
        assertGt(_tick(hookedKey), 600);
        assertEq(d.amount0(), int256(x));
        assertEq(d.amount1(), r.amount1());
        assertEq(hook.pendingFees(), fee);
        assertEq(_tick(hookedKey), _tick(refKey));
    }

    // =========================================================================================== extreme amounts

    function test_tinyAmounts_allFourCases() public {
        // BUY exactIn 1 wei: whole wei is fee, nothing swapped
        BalanceDelta d = _buyExactIn(hookedKey, 1);
        assertEq(d.amount0(), -1);
        assertEq(d.amount1(), 0);
        assertEq(hook.pendingFees(), 1);
        // SELL exactIn 1 wei: pool outputs 0 ETH -> no fee
        d = _sellExactIn(hookedKey, 1);
        assertEq(d.amount0(), 0);
        assertEq(hook.pendingFees(), 1);
        // BUY exactOut 1 wei of token: pool needs P (1-2 wei), fee = ceil(P/9) = 1
        d = _buyExactOut(hookedKey, 1, 1 ether);
        assertEq(d.amount1(), 1);
        uint256 p = uint256(-int256(d.amount0()));
        assertEq(hook.pendingFees(), 2);
        assertEq(p, uint256(-int256(_buyExactOut(refKey, 1, 1 ether).amount0())) + 1);
        // SELL exactOut 1 wei net: pool pays 2 wei, fee 1 wei
        d = _sellExactOut(hookedKey, 1);
        assertEq(d.amount0(), 1);
        assertEq(hook.pendingFees(), 3);
        BalanceDelta r = _sellExactOut(refKey, 2);
        assertEq(d.amount1(), r.amount1());
    }

    function test_hugeAmounts_allFourCases() public {
        // BUY exactIn 1M ETH into a 10k ETH pool: fully consumed (full-range liquidity), huge price impact
        uint256 x = 1_000_000 ether;
        BalanceDelta d = _buyExactIn(hookedKey, x);
        BalanceDelta r = _buyExactIn(refKey, x - _feeOnGross(x));
        assertEq(d.amount0(), -int256(x));
        assertEq(d.amount1(), r.amount1());
        assertEq(hook.pendingFees(), 100_000 ether);

        // SELL exactIn 100M WAR (10% of supply)
        uint256 t = 100_000_000 ether;
        r = _sellExactIn(refKey, t);
        uint256 g = uint256(int256(r.amount0()));
        uint256 before = hook.pendingFees();
        d = _sellExactIn(hookedKey, t);
        uint256 fee = hook.pendingFees() - before;
        assertEq(uint256(int256(d.amount0())), g - fee);
        _assertTenPercent(fee, g);

        // BUY exactOut 90% of the WAR the (full-range) position holds at the current price
        uint256 want = LiquidityAmounts.getAmount1ForLiquidity(
                TickMath.getSqrtPriceAtTick(FULL_LOWER), _sqrtPrice(hookedKey), _liquidity(hookedKey)
            ) * 9 / 10;
        r = _buyExactOut(refKey, want, 1e29);
        uint256 p = uint256(-int256(r.amount0()));
        before = hook.pendingFees();
        d = _buyExactOut(hookedKey, want, 1e29);
        fee = hook.pendingFees() - before;
        assertEq(d.amount1(), int256(want));
        assertEq(uint256(-int256(d.amount0())), p + fee);
        _assertTenPercent(fee, p + fee);

        // SELL exactOut 50% of the ETH the position holds at the current price
        uint256 xo = LiquidityAmounts.getAmount0ForLiquidity(
            _sqrtPrice(hookedKey), TickMath.getSqrtPriceAtTick(FULL_UPPER), _liquidity(hookedKey)
        ) / 2;
        before = hook.pendingFees();
        d = _sellExactOut(hookedKey, xo);
        fee = hook.pendingFees() - before;
        assertEq(d.amount0(), int256(xo));
        _assertTenPercent(fee, xo + fee);
        r = _sellExactOut(refKey, xo + fee);
        assertEq(d.amount1(), r.amount1());
    }

    // =========================================================================================== flush after all

    function test_flushAfterMixedActivity() public {
        _buyExactIn(hookedKey, 3 ether);
        _buyExactOut(hookedKey, 2 ether, 10 ether);
        _sellExactIn(hookedKey, 4 ether);
        _sellExactOut(hookedKey, 1 ether);
        uint256 pending = hook.pendingFees();
        hook.flush();
        assertEq(address(vault).balance, pending - 1);
        assertEq(hook.pendingFees(), 1);
        assertEq(address(hook).balance, 0);
    }
}
