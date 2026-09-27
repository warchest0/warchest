// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MockV4Router} from "@uniswap/v4-periphery/test/mocks/MockV4Router.sol";
import {Plan, Planner} from "@uniswap/v4-periphery/test/shared/Planner.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {WarchestHookFixture, MockVault} from "./utils/WarchestHookFixture.sol";

/// @notice Router compatibility: the v4-periphery `V4Router` actions path (single-hop, both directions, exactIn and
///         exactOut, multi-hop through the hooked pool, slippage checks). PoolSwapTest coverage lives in the other
///         suites; the UniversalRouter is covered on the Robinhood fork.
contract WarchestHookRouterTest is WarchestHookFixture {
    MockVault vault;
    MockV4Router router;
    MockERC20 other;
    PoolKey otherKey; // WAR/OTHER plain pool for multi-hop routes
    Currency WAR;
    Currency OTHER;

    function setUp() public {
        deployFreshManagerAndRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e27);
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);

        router = new MockV4Router(manager);
        token.approve(address(router), type(uint256).max);
        WAR = Currency.wrap(address(token));

        other = new MockERC20("OTHER", "OTH", 18);
        other.mint(address(this), 1e27);
        other.approve(address(router), type(uint256).max);
        other.approve(address(modifyLiquidityRouter), type(uint256).max);
        OTHER = Currency.wrap(address(other));
        (Currency c0, Currency c1) = address(other) < address(token) ? (OTHER, WAR) : (WAR, OTHER);
        otherKey = PoolKey(c0, c1, LP_FEE, TICK_SPACING, IHooks(address(0)));
        manager.initialize(otherKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            otherKey, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, 10_000 ether, 0), ""
        );
    }

    function _single(bool zeroForOne, uint128 amountIn, uint128 minOut) internal view returns (bytes memory) {
        return abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: hookedKey,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
    }

    function _singleOut(bool zeroForOne, uint128 amountOut, uint128 maxIn) internal view returns (bytes memory) {
        return abi.encode(
            IV4Router.ExactOutputSingleParams({
                poolKey: hookedKey,
                zeroForOne: zeroForOne,
                amountOut: amountOut,
                amountInMaximum: maxIn,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
    }

    // =========================================================================================== single hop

    function test_router_buyExactIn() public {
        uint256 x = 1 ether;
        uint256 fee = _feeOnGross(x);
        BalanceDelta ref = _buyExactIn(refKey, x - fee);

        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_IN_SINGLE, _single(true, uint128(x), 0));
        bytes memory data = plan.finalizeSwap(CurrencyLibrary.ADDRESS_ZERO, WAR, address(this));
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        router.executeActions{value: x}(data);

        assertEq(ethBefore - address(this).balance, x);
        assertEq(token.balanceOf(address(this)) - tokBefore, uint256(int256(ref.amount1())));
        assertEq(hook.pendingFees(), fee);
    }

    function test_router_buyExactOut() public {
        uint256 t = 500 ether;
        BalanceDelta ref = _buyExactOut(refKey, t, 1e26);
        uint256 p = uint256(-int256(ref.amount0()));
        uint256 fee = _feeOnNet(p);

        Plan memory plan =
            Planner.init().add(Actions.SWAP_EXACT_OUT_SINGLE, _singleOut(true, uint128(t), type(uint128).max));
        bytes memory data = plan.finalizeSwap(CurrencyLibrary.ADDRESS_ZERO, WAR, address(this));
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        router.executeActionsAndSweepExcessETH{value: p + fee + 1 ether}(data);

        assertEq(token.balanceOf(address(this)) - tokBefore, t, "exact output delivered");
        assertEq(ethBefore - address(this).balance, p + fee, "excess ETH swept back");
        assertEq(hook.pendingFees(), fee);
    }

    function test_router_sellExactIn() public {
        uint256 t = 500 ether;
        BalanceDelta ref = _sellExactIn(refKey, t);
        uint256 g = uint256(int256(ref.amount0()));
        uint256 fee = _feeOnGross(g);

        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_IN_SINGLE, _single(false, uint128(t), 0));
        bytes memory data = plan.finalizeSwap(WAR, CurrencyLibrary.ADDRESS_ZERO, address(this));
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        router.executeActions(data);

        assertEq(tokBefore - token.balanceOf(address(this)), t);
        assertEq(address(this).balance - ethBefore, g - fee);
        assertEq(hook.pendingFees(), fee);
    }

    function test_router_sellExactOut() public {
        uint256 x = 1 ether;
        uint256 fee = _feeOnNet(x);
        BalanceDelta ref = _sellExactOut(refKey, x + fee);

        Plan memory plan =
            Planner.init().add(Actions.SWAP_EXACT_OUT_SINGLE, _singleOut(false, uint128(x), type(uint128).max));
        bytes memory data = plan.finalizeSwap(WAR, CurrencyLibrary.ADDRESS_ZERO, address(this));
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        router.executeActions(data);

        assertEq(address(this).balance - ethBefore, x, "exact net ETH output");
        assertEq(tokBefore - token.balanceOf(address(this)), uint256(-int256(ref.amount1())));
        assertEq(hook.pendingFees(), fee);
    }

    // =========================================================================================== slippage

    function test_router_slippageSeesTheFee() public {
        // asking for the hook-less output makes the router revert: the fee is visible to slippage protection
        uint256 x = 1 ether;
        BalanceDelta ref = _buyExactIn(refKey, x);
        uint128 noFeeOut = uint128(uint256(int256(ref.amount1())));
        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_IN_SINGLE, _single(true, uint128(x), noFeeOut));
        bytes memory data = plan.finalizeSwap(CurrencyLibrary.ADDRESS_ZERO, WAR, address(this));
        vm.expectPartialRevert(IV4Router.V4TooLittleReceived.selector);
        router.executeActions{value: x}(data);
    }

    function test_router_sellExactOut_maxInputSeesTheFee() public {
        uint256 x = 1 ether;
        BalanceDelta ref = _sellExactOut(refKey, x); // token cost for X without the fee
        uint128 noFeeIn = uint128(uint256(-int256(ref.amount1())));
        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_OUT_SINGLE, _singleOut(false, uint128(x), noFeeIn));
        bytes memory data = plan.finalizeSwap(WAR, CurrencyLibrary.ADDRESS_ZERO, address(this));
        vm.expectPartialRevert(IV4Router.V4TooMuchRequested.selector);
        router.executeActions(data);
    }

    // =========================================================================================== multi-hop

    function test_router_multiHopExactIn_ethToWarToOther() public {
        uint256 x = 1 ether;
        uint256 fee = _feeOnGross(x);
        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(WAR, LP_FEE, TICK_SPACING, hook, "");
        path[1] = PathKey(OTHER, LP_FEE, TICK_SPACING, IHooks(address(0)), "");
        IV4Router.ExactInputParams memory params = IV4Router.ExactInputParams({
            currencyIn: CurrencyLibrary.ADDRESS_ZERO,
            path: path,
            minHopPriceX36: new uint256[](0),
            amountIn: uint128(x),
            amountOutMinimum: 0
        });
        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_IN, abi.encode(params));
        bytes memory data = plan.finalizeSwap(CurrencyLibrary.ADDRESS_ZERO, OTHER, address(this));

        uint256 ethBefore = address(this).balance;
        uint256 otherBefore = other.balanceOf(address(this));
        router.executeActions{value: x}(data);

        assertEq(ethBefore - address(this).balance, x);
        assertGt(other.balanceOf(address(this)), otherBefore);
        assertEq(hook.pendingFees(), fee, "fee charged once, on the ETH hop");
    }

    function test_router_multiHopExactOut_otherFromEth() public {
        uint256 want = 100 ether; // OTHER out
        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(CurrencyLibrary.ADDRESS_ZERO, LP_FEE, TICK_SPACING, hook, ""); // input of hop 0
        path[1] = PathKey(WAR, LP_FEE, TICK_SPACING, IHooks(address(0)), ""); // input of hop 1
        IV4Router.ExactOutputParams memory params = IV4Router.ExactOutputParams({
            currencyOut: OTHER,
            path: path,
            minHopPriceX36: new uint256[](0),
            amountOut: uint128(want),
            amountInMaximum: type(uint128).max
        });
        Plan memory plan = Planner.init().add(Actions.SWAP_EXACT_OUT, abi.encode(params));
        bytes memory data = plan.finalizeSwap(CurrencyLibrary.ADDRESS_ZERO, OTHER, address(this));

        uint256 ethBefore = address(this).balance;
        uint256 otherBefore = other.balanceOf(address(this));
        router.executeActionsAndSweepExcessETH{value: 1_000 ether}(data);

        uint256 spent = ethBefore - address(this).balance;
        uint256 fee = hook.pendingFees();
        assertEq(other.balanceOf(address(this)) - otherBefore, want);
        assertGt(fee, 0);
        // gross ETH leg == everything the buyer spent (P + fee): fee within 1 wei of 10%
        assertGe(fee * 10, spent);
        assertLt(fee * 10, spent + 10);
    }
}
