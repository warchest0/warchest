// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {WarchestToken} from "../../src/WarchestToken.sol";
import {WarchestHook} from "../../src/WarchestHook.sol";
import {WarchestHookFixture, MockVault} from "../utils/WarchestHookFixture.sol";

/// @dev Random trader / LP / keeper. Every action is bounded so that failures other than the hook's own
///      `PartialFill` are not expected; accounting is tracked in ghost variables checked by the invariants.
contract WarchestHandler is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager immutable manager;
    PoolSwapTest immutable router;
    PoolModifyLiquidityTest immutable lpRouter;
    WarchestToken immutable token;
    WarchestHook immutable hook;
    MockVault immutable vault;
    PoolKey key;

    // ghost accounting
    uint256 public ghostFees; // sum of fees observed through pendingFees() deltas
    uint256 public ghostGross; // sum of gross ETH legs
    uint256 public swaps;
    uint256 public partialFillReverts;
    uint256 public otherReverts;
    bytes4 public lastOtherRevert; // selector of the last non-PartialFill revert, for diagnostics
    uint256 public flushes;
    uint256 public violations; // any per-action property violated (checked by an invariant)
    uint256 public lpOps;

    constructor(
        IPoolManager manager_,
        PoolSwapTest router_,
        PoolModifyLiquidityTest lpRouter_,
        WarchestToken token_,
        WarchestHook hook_,
        MockVault vault_,
        PoolKey memory key_
    ) {
        manager = manager_;
        router = router_;
        lpRouter = lpRouter_;
        token = token_;
        hook = hook_;
        vault = vault_;
        key = key_;
        token.approve(address(router), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
    }

    receive() external payable {}

    // ------------------------------------------------------------------ swaps

    function buyExactIn(uint256 x) external {
        x = bound(x, 1, 200 ether);
        _swap(true, -int256(x), TickMath.MIN_SQRT_PRICE + 1, x);
    }

    function buyExactOut(uint256 t) external {
        t = bound(t, 1, 200 ether);
        _swap(true, int256(t), TickMath.MIN_SQRT_PRICE + 1, address(this).balance / 2);
    }

    function sellExactIn(uint256 t) external {
        t = bound(t, 1, 200 ether);
        _swap(false, -int256(t), TickMath.MAX_SQRT_PRICE - 1, 0);
    }

    function sellExactOut(uint256 x) external {
        x = bound(x, 1, 200 ether);
        _swap(false, int256(x), TickMath.MAX_SQRT_PRICE - 1, 0);
    }

    /// @dev Tight price limits: exercises partial fills (allowed in afterSwap cases, rejected in beforeSwap cases).
    function limitedSwap(uint256 amount, uint256 kind, uint256 bps) external {
        amount = bound(amount, 1, 200 ether);
        kind = bound(kind, 0, 3);
        bps = bound(bps, 1, 500);
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        bool zeroForOne = kind < 2;
        int256 specified = (kind % 2 == 0) ? -int256(amount) : int256(amount);
        uint160 limit = zeroForOne
            ? uint160(uint256(sqrtP) * (10_000 - bps) / 10_000)
            : uint160(uint256(sqrtP) * (10_000 + bps) / 10_000);
        if (limit <= TickMath.MIN_SQRT_PRICE || limit >= TickMath.MAX_SQRT_PRICE) return;
        _swap(zeroForOne, specified, limit, zeroForOne ? address(this).balance / 2 : 0);
    }

    function _swap(bool zeroForOne, int256 specified, uint160 limit, uint256 value) internal {
        uint256 pendingBefore = hook.pendingFees();
        uint256 vaultBefore = address(vault).balance;
        try router.swap{value: value}(
            key, SwapParams(zeroForOne, specified, limit), PoolSwapTest.TestSettings(false, false), ""
        ) returns (
            BalanceDelta d
        ) {
            uint256 fee = hook.pendingFees() - pendingBefore;
            uint256 gross;
            if (zeroForOne) {
                // buyer pays -d0 in total (exactIn: X, exactOut: P + fee)
                gross = uint256(-int256(d.amount0()));
            } else {
                // seller receives d0 net; the pool paid d0 + fee
                gross = uint256(int256(d.amount0())) + fee;
            }
            // 0 <= fee - gross/10 < 1 wei
            if (!(fee * 10 >= gross && fee * 10 < gross + 10)) violations++;
            if (address(vault).balance != vaultBefore) violations++;
            ghostFees += fee;
            ghostGross += gross;
            swaps++;
        } catch (bytes memory err) {
            if (_isPartialFill(err)) {
                partialFillReverts++;
            } else {
                otherReverts++;
                lastOtherRevert = _innerSelector(err);
            }
            if (hook.pendingFees() != pendingBefore) violations++;
        }
    }

    function _isPartialFill(bytes memory err) internal pure returns (bool) {
        return _innerSelector(err) == WarchestHook.PartialFill.selector;
    }

    /// @dev Selector of the hook's reason inside a `WrappedError`, or the outer selector otherwise.
    function _innerSelector(bytes memory err) internal pure returns (bytes4) {
        if (err.length < 4) return bytes4(0);
        if (bytes4(err) != CustomRevert.WrappedError.selector) return bytes4(err);
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        return reason.length >= 4 ? bytes4(reason) : bytes4(0);
    }

    // ------------------------------------------------------------------ liquidity

    function addLiquidity(uint256 liq, uint256 rangeSeed) external {
        liq = bound(liq, 1e15, 2_000 ether);
        (int24 lower, int24 upper) = _range(rangeSeed);
        uint256 pendingBefore = hook.pendingFees();
        try lpRouter.modifyLiquidity{value: address(this).balance / 2}(
            key, ModifyLiquidityParams(lower, upper, int256(liq), 0), ""
        ) {
            lpOps++;
        } catch {
            otherReverts++;
        }
        if (hook.pendingFees() != pendingBefore) violations++;
    }

    function removeLiquidity(uint256 rangeSeed, uint256 fraction) external {
        (int24 lower, int24 upper) = _range(rangeSeed);
        fraction = bound(fraction, 1, 100);
        (uint128 liq,,) = manager.getPositionInfo(key.toId(), address(lpRouter), lower, upper, 0);
        if (liq == 0) return;
        uint256 pendingBefore = hook.pendingFees();
        try lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, -int256(uint256(liq) * fraction / 100), 0), ""
        ) {
            lpOps++;
        } catch {
            otherReverts++;
        }
        if (hook.pendingFees() != pendingBefore) violations++;
    }

    function _range(uint256 seed) internal pure returns (int24 lower, int24 upper) {
        uint256 r = seed % 4;
        if (r == 0) return (-887_220, 887_220);
        if (r == 1) return (-6000, 6000);
        if (r == 2) return (-600, 600);
        return (-60, 60);
    }

    // ------------------------------------------------------------------ keeper

    function flush() external {
        uint256 pending = hook.pendingFees();
        uint256 vaultBefore = address(vault).balance;
        if (pending <= 1) {
            try hook.flush() {
                violations++;
            } catch {}
            return;
        }
        uint256 amount = hook.flush();
        if (amount != pending - 1) violations++;
        if (address(vault).balance != vaultBefore + amount) violations++;
        if (hook.pendingFees() != 1) violations++;
        flushes++;
    }
}

/// @notice Stateful invariants of WarchestHook under random swaps (all four kinds, with and without price limits),
///         liquidity changes and flushes.
contract WarchestHookInvariantTest is WarchestHookFixture {
    using TransientStateLibrary for IPoolManager;

    MockVault vault;
    WarchestHandler handler;
    uint256 initialSupply;

    function setUp() public {
        deployFreshManagerAndRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e30);
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);
        _addLiquidity(hookedKey, -600, 600, 5_000 ether, 10_000 ether);

        handler = new WarchestHandler(manager, swapRouter, modifyLiquidityRouter, token, hook, vault, hookedKey);
        vm.deal(address(handler), 1e27);
        token.transfer(address(handler), 500_000_000 ether);
        initialSupply = token.totalSupply();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = WarchestHandler.buyExactIn.selector;
        selectors[1] = WarchestHandler.buyExactOut.selector;
        selectors[2] = WarchestHandler.sellExactIn.selector;
        selectors[3] = WarchestHandler.sellExactOut.selector;
        selectors[4] = WarchestHandler.limitedSwap.selector;
        selectors[5] = WarchestHandler.addLiquidity.selector;
        selectors[6] = WarchestHandler.removeLiquidity.selector;
        selectors[7] = WarchestHandler.flush.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev vault received + pending claims == sum of every fee ever charged (no fee lost, none created).
    function invariant_feesConserved() public view {
        assertEq(address(vault).balance + hook.pendingFees(), handler.ghostFees());
    }

    /// @dev Every single fee and the running total are within 1 wei (per swap) of 10% of the gross ETH leg.
    function invariant_feeIsTenPercentOfGross() public view {
        assertEq(handler.violations(), 0, "per-action property violated");
        uint256 fees = handler.ghostFees();
        uint256 gross = handler.ghostGross();
        assertGe(fees * 10, gross);
        assertLt(fees * 10, gross + 10 * handler.swaps() + 10);
    }

    /// @dev The hook never holds ETH or tokens: its only asset is the ERC-6909 claims tracked by pendingFees().
    function invariant_hookHoldsNothing() public view {
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }

    /// @dev Every PoolManager unlock ended fully settled: no delta left on the hook, manager locked.
    function invariant_deltasSettled() public view {
        assertFalse(manager.isUnlocked());
        assertEq(manager.currencyDelta(address(hook), CurrencyLibrary.ADDRESS_ZERO), 0);
        assertEq(manager.currencyDelta(address(hook), Currency.wrap(address(token))), 0);
        assertEq(manager.getNonzeroDeltaCount(), 0);
    }

    /// @dev Claims are backed by ETH actually held by the PoolManager.
    function invariant_claimsBackedByEth() public view {
        assertGe(address(manager).balance, hook.pendingFees());
    }

    function invariant_tokenSupplyConstant() public view {
        assertEq(token.totalSupply(), initialSupply);
    }

    function invariant_onlyOnePool() public view {
        assertEq(PoolId.unwrap(PoolIdLibrary.toId(hookedKey)), PoolId.unwrap(hook.poolId()));
    }

    function afterInvariant() public view {
        console2.log("swaps", handler.swaps());
        console2.log("partial-fill reverts", handler.partialFillReverts());
        console2.log("other reverts", handler.otherReverts());
        console2.logBytes4(handler.lastOtherRevert());
        console2.log("lp ops", handler.lpOps());
        console2.log("flushes", handler.flushes());
        console2.log("fees (wei)", handler.ghostFees());
    }
}
