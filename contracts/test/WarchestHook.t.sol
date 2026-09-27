// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IHookEvents} from "@openzeppelin/uniswap-hooks/interfaces/IHookEvents.sol";
import {WarchestToken} from "../src/WarchestToken.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {HookMiner} from "../script/utils/HookMiner.sol";
import {WarchestHookFixture, MockVault, ReentrantVault} from "./utils/WarchestHookFixture.sol";

/// @notice Unit tests of WarchestHook on a fresh local PoolManager (v4-core Deployers).
contract WarchestHookTest is WarchestHookFixture {
    using PoolIdLibrary for PoolKey;

    MockVault vault;
    address keeper = makeAddr("keeper");

    function setUp() public {
        deployFreshManagerAndRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e27);
        // 10_000 ETH + 10_000 WAR of full-range liquidity on both pools
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);
    }

    // =========================================================================================== deployment

    function test_addressEncodesPermissions() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS);
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(
            p.beforeInitialize && p.beforeSwap && p.afterSwap && p.beforeSwapReturnDelta && p.afterSwapReturnDelta
        );
        assertFalse(
            p.afterInitialize || p.beforeAddLiquidity || p.afterAddLiquidity || p.beforeRemoveLiquidity
                || p.afterRemoveLiquidity || p.beforeDonate || p.afterDonate || p.afterAddLiquidityReturnDelta
                || p.afterRemoveLiquidityReturnDelta
        );
    }

    function test_immutablesAndConstants() public view {
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(Currency.unwrap(hook.token()), address(token));
        assertEq(hook.vault(), address(vault));
        assertEq(hook.initializer(), address(this));
        assertEq(hook.FEE_BPS(), 1000);
        assertEq(hook.BPS(), 10_000);
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(hookedId));
    }

    function test_deployRevertsOnWrongAddressFlags() public {
        // plain CREATE: the address does not carry the flags, BaseHook's constructor must reject it
        try this.externalDeployNoFlags() {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), Hooks.HookAddressNotValid.selector);
        }
    }

    function externalDeployNoFlags() external {
        new WarchestHook(manager, address(token), address(vault), address(this));
    }

    function test_constructorRejectsZeroAddresses() public {
        _expectZeroAddress(address(0), address(vault), address(this));
        _expectZeroAddress(address(token), address(0), address(this));
        _expectZeroAddress(address(token), address(vault), address(0));
    }

    function _expectZeroAddress(address token_, address vault_, address initializer_) internal {
        (, bytes32 salt) = HookMiner.find(
            address(this),
            HOOK_FLAGS,
            type(WarchestHook).creationCode,
            abi.encode(manager, token_, vault_, initializer_)
        );
        vm.expectRevert(WarchestHook.ZeroAddress.selector);
        new WarchestHook{salt: salt}(manager, token_, vault_, initializer_);
    }

    // =========================================================================================== beforeInitialize

    function test_initialize_rejectsUnauthorizedSender() public {
        WarchestHook fresh = _deployHook(address(token), address(vault), address(this));
        PoolKey memory k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), 500, 10, fresh);
        address attacker = makeAddr("attacker");
        hook = fresh; // for _hookRevert
        _expectHookRevert(
            IHooks.beforeInitialize.selector,
            abi.encodeWithSelector(WarchestHook.UnauthorizedInitializer.selector, attacker)
        );
        vm.prank(attacker);
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_initialize_rejectsWrongCurrency1() public {
        WarchestHook fresh = _deployHook(address(token), address(vault), address(this));
        MockERC20 other = new MockERC20("OTHER", "OTH", 18);
        PoolKey memory k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(other)), 500, 10, fresh);
        hook = fresh;
        _expectHookRevert(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.InvalidPoolCurrencies.selector)
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_initialize_rejectsNonNativeCurrency0() public {
        WarchestHook fresh = _deployHook(address(token), address(vault), address(this));
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (Currency c0, Currency c1) = address(a) < address(b)
            ? (Currency.wrap(address(a)), Currency.wrap(address(b)))
            : (Currency.wrap(address(b)), Currency.wrap(address(a)));
        // token/token pool (neither is ETH) and also an ERC20/WAR pool where currency0 is not ETH
        PoolKey memory k = PoolKey(c0, c1, 500, 10, fresh);
        hook = fresh;
        _expectHookRevert(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.InvalidPoolCurrencies.selector)
        );
        manager.initialize(k, SQRT_PRICE_1_1);

        address low = address(a) < address(token) ? address(a) : address(b) < address(token) ? address(b) : address(0);
        if (low != address(0)) {
            PoolKey memory k2 = PoolKey(Currency.wrap(low), Currency.wrap(address(token)), 500, 10, fresh);
            _expectHookRevert(
                IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.InvalidPoolCurrencies.selector)
            );
            manager.initialize(k2, SQRT_PRICE_1_1);
        }
    }

    function test_initialize_rejectsDynamicFee() public {
        WarchestHook fresh = _deployHook(address(token), address(vault), address(this));
        PoolKey memory k = PoolKey(
            CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, fresh
        );
        hook = fresh;
        _expectHookRevert(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.DynamicFeeNotSupported.selector)
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_initialize_rejectsSecondPool() public {
        // the canonical pool is already initialised in setUp; a second fee tier by the initializer must fail
        PoolKey memory k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), 500, 10, hook);
        _expectHookRevert(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.PoolAlreadyInitialized.selector)
        );
        manager.initialize(k, SQRT_PRICE_1_1);
        // re-initialising the same key: the hook rejects it too (beforeInitialize runs before the PoolManager check)
        _expectHookRevert(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(WarchestHook.PoolAlreadyInitialized.selector)
        );
        manager.initialize(hookedKey, SQRT_PRICE_1_1);
    }

    // =========================================================================================== exactIn BUY

    function test_buyExactIn_charges10PercentOfEthIn() public {
        uint256 x = 1 ether;
        uint256 fee = _feeOnGross(x);
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));

        vm.expectEmit(true, true, true, true, address(hook));
        emit IHookEvents.HookFee(PoolId.unwrap(hookedId), address(swapRouter), uint128(fee), 0);
        BalanceDelta d = _buyExactIn(hookedKey, x);

        assertEq(fee, 0.1 ether);
        assertEq(d.amount0(), -int256(x), "user pays exactly X");
        assertEq(ethBefore - address(this).balance, x, "ETH balance moved by X");
        assertEq(token.balanceOf(address(this)) - tokBefore, uint256(int256(d.amount1())), "tokens received");
        assertEq(hook.pendingFees(), fee, "fee accrued as claims");
        assertEq(address(vault).balance, 0, "vault paid only on flush");

        // equivalence: the pool saw an input of X - fee, i.e. the same output as a hook-less pool given X - fee
        BalanceDelta r = _buyExactIn(refKey, x - fee);
        assertEq(d.amount1(), r.amount1(), "same output as reference pool for X - fee");
        assertEq(_sqrtPrice(hookedKey), _sqrtPrice(refKey), "same resulting price");
    }

    function test_buyExactIn_dustAmounts() public {
        // ceil rounding: 1..10 wei -> fee 1 wei; 11 wei -> 2 wei
        for (uint256 x = 1; x <= 11; ++x) {
            uint256 before = hook.pendingFees();
            BalanceDelta d = _buyExactIn(hookedKey, x);
            assertEq(d.amount0(), -int256(x));
            assertEq(hook.pendingFees() - before, x <= 10 ? 1 : 2);
        }
    }

    function testFuzz_buyExactIn_feeWithinOneWeiOf10Percent(uint256 x) public {
        x = bound(x, 1, 5_000 ether);
        BalanceDelta d = _buyExactIn(hookedKey, x);
        uint256 fee = hook.pendingFees();
        assertEq(d.amount0(), -int256(x));
        // 0 <= fee - x/10 < 1  <=>  x <= 10*fee < x + 10
        assertGe(fee * 10, x);
        assertLt(fee * 10, x + 10);
        // and the pool really swapped X - fee: identical to the reference pool (x == 1 => fee == 1, nothing swapped)
        if (x > fee) {
            BalanceDelta r = _buyExactIn(refKey, x - fee);
            assertEq(d.amount1(), r.amount1());
        } else {
            assertEq(d.amount1(), 0);
        }
    }

    // =========================================================================================== exactIn SELL

    function test_sellExactIn_charges10PercentOfEthOut() public {
        uint256 t = 1000 ether;
        BalanceDelta r = _sellExactIn(refKey, t);
        uint256 gross = uint256(int256(r.amount0()));
        uint256 fee = _feeOnGross(gross);

        uint256 ethBefore = address(this).balance;
        vm.expectEmit(true, true, true, true, address(hook));
        emit IHookEvents.HookFee(PoolId.unwrap(hookedId), address(swapRouter), uint128(fee), 0);
        BalanceDelta d = _sellExactIn(hookedKey, t);

        assertEq(d.amount1(), -int256(t), "user pays exactly T tokens");
        assertEq(d.amount0(), int256(gross - fee), "user receives gross - fee");
        assertEq(address(this).balance - ethBefore, gross - fee);
        assertEq(hook.pendingFees(), fee);
        assertEq(_sqrtPrice(hookedKey), _sqrtPrice(refKey));
    }

    function testFuzz_sellExactIn_feeWithinOneWeiOf10Percent(uint256 t) public {
        t = bound(t, 1, 5_000 ether);
        BalanceDelta r = _sellExactIn(refKey, t);
        uint256 gross = uint256(int256(r.amount0()));
        BalanceDelta d = _sellExactIn(hookedKey, t);
        uint256 fee = hook.pendingFees();
        assertEq(d.amount1(), -int256(t));
        assertEq(uint256(int256(d.amount0())) + fee, gross, "net + fee == gross");
        assertGe(fee * 10, gross);
        assertLt(fee * 10, gross + 10);
    }

    function test_sellExactIn_zeroEthOutChargesNothing() public {
        // 1 wei of token yields 0 ETH at 1:1 with a 0.3% LP fee -> no fee, no event, no claims
        BalanceDelta d = _sellExactIn(hookedKey, 1);
        assertEq(d.amount0(), 0);
        assertEq(hook.pendingFees(), 0);
    }

    // =========================================================================================== partial fills

    function test_buyExactIn_priceLimitPartialFill_reverts() public {
        // a limit just below the current price: the pool can only consume a fraction of the input
        uint160 limit = _sqrtPrice(hookedKey) * 999 / 1000;
        try swapRouter.swap{value: 100 ether}(
            hookedKey, SwapParams(true, -100 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        ) {
            fail();
        } catch (bytes memory err) {
            _assertHookRevert(err, IHooks.afterSwap.selector, WarchestHook.PartialFill.selector);
        }
        assertEq(hook.pendingFees(), 0, "nothing accrued on revert");
        // the same swap with the limit fully works on the reference pool (partial fill is a v4 feature, not a bug)
        swapRouter.swap{value: 100 ether}(
            refKey, SwapParams(true, -100 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    // =========================================================================================== fee delivery

    function test_flush_sendsClaimsToVault() public {
        _buyExactIn(hookedKey, 1 ether);
        _sellExactIn(hookedKey, 500 ether);
        uint256 pending = hook.pendingFees();
        assertGt(pending, 0.1 ether);

        vm.expectEmit(true, true, true, true, address(hook));
        emit WarchestHook.FeesFlushed(keeper, pending - 1);
        vm.prank(keeper);
        uint256 flushed = hook.flush();

        assertEq(flushed, pending - 1, "flush leaves 1 wei of claims as slot warm-keeper");
        assertEq(address(vault).balance, pending - 1);
        assertEq(vault.received(), pending - 1);
        assertEq(hook.pendingFees(), 1);
        assertEq(address(hook).balance, 0, "hook never holds ETH");

        vm.expectRevert(WarchestHook.NothingToFlush.selector);
        hook.flush();

        // the remainder is not lost: it is included in the next flush
        _buyExactIn(hookedKey, 1 ether);
        assertEq(hook.pendingFees(), 0.1 ether + 1);
        assertEq(hook.flush(), 0.1 ether);
        assertEq(address(vault).balance, pending - 1 + 0.1 ether);
    }

    function test_flush_vaultRejectingEthDoesNotBlockSwaps() public {
        vault.setRejectEth(true);
        _buyExactIn(hookedKey, 1 ether);
        _sellExactIn(hookedKey, 100 ether);
        uint256 pending = hook.pendingFees();
        assertGt(pending, 0);

        vm.expectRevert();
        hook.flush();
        assertEq(hook.pendingFees(), pending, "claims untouched by a failed flush");

        vault.setRejectEth(false);
        hook.flush();
        assertEq(address(vault).balance, pending - 1);
    }

    function test_flush_reentrancyFromVaultCannotDoubleSpend() public {
        ReentrantVault rv = new ReentrantVault();
        WarchestHook h = _deployHook(address(token), address(rv), address(this));
        rv.setHook(h);
        PoolKey memory k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), 500, 10, h);
        manager.initialize(k, SQRT_PRICE_1_1);
        _addLiquidity(k, -887_270, 887_270, 1_000 ether, 2_000 ether);
        _buyExactIn(k, 1 ether);
        uint256 pending = h.pendingFees();

        h.flush();
        assertTrue(rv.attempted(), "vault re-entered flush");
        assertFalse(rv.innerSucceeded(), "re-entrant flush must fail (manager already unlocked / nothing to flush)");
        assertEq(address(rv).balance, pending - 1, "paid exactly once");
        assertEq(h.pendingFees(), 1);
    }

    // =========================================================================================== no fee elsewhere

    function test_addRemoveLiquidity_noFee() public {
        BalanceDelta addHooked = _addLiquidity(hookedKey, -600, 600, 1_000 ether, 100 ether);
        BalanceDelta addRef = _addLiquidity(refKey, -600, 600, 1_000 ether, 100 ether);
        assertEq(addHooked.amount0(), addRef.amount0());
        assertEq(addHooked.amount1(), addRef.amount1());
        BalanceDelta rmHooked = _addLiquidity(hookedKey, -600, 600, -1_000 ether, 0);
        BalanceDelta rmRef = _addLiquidity(refKey, -600, 600, -1_000 ether, 0);
        assertEq(rmHooked.amount0(), rmRef.amount0());
        assertEq(rmHooked.amount1(), rmRef.amount1());
        assertEq(hook.pendingFees(), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_tokenTransfersUntouched() public {
        address bob = makeAddr("bob");
        uint256 supply = token.totalSupply();
        token.transfer(bob, 123 ether);
        assertEq(token.balanceOf(bob), 123 ether);
        assertEq(token.totalSupply(), supply);
        assertEq(hook.pendingFees(), 0);
    }

    // =========================================================================================== access & balances

    function test_entryPointsOnlyCallableByPoolManager() public {
        SwapParams memory p = SwapParams(true, -1, 0);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), hookedKey, p, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterSwap(address(this), hookedKey, p, BalanceDelta.wrap(0), "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), hookedKey, SQRT_PRICE_1_1);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(uint256(1)));
    }

    function test_hookHasNoReceiveAndHoldsNothing() public {
        _buyExactIn(hookedKey, 1 ether);
        _sellExactIn(hookedKey, 100 ether);
        (bool ok,) = address(hook).call{value: 1}("");
        assertFalse(ok, "hook must not accept ETH");
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }

    function test_noPrivilegedSurface() public view {
        bytes4[5] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("setFee(uint256)")),
            bytes4(keccak256("setVault(address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("transferOwnership(address)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(hook).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok);
        }
    }

    function test_feeHelpers() public view {
        assertEq(hook.feeOnGross(0), 0);
        assertEq(hook.feeOnGross(1), 1);
        assertEq(hook.feeOnGross(10), 1);
        assertEq(hook.feeOnGross(11), 2);
        assertEq(hook.feeOnGross(1 ether), 0.1 ether);
        assertEq(hook.feeOnNet(0), 0);
        assertEq(hook.feeOnNet(9), 1);
        assertEq(hook.feeOnNet(10), 2);
        assertEq(hook.feeOnNet(9 ether), 1 ether);
    }
}
