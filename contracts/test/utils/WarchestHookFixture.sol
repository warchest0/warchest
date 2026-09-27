// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {WarchestToken} from "../../src/WarchestToken.sol";
import {WarchestHook} from "../../src/WarchestHook.sol";
import {HookMiner} from "../../script/utils/HookMiner.sol";

/// @dev Vault that can be toggled to reject ETH, to exercise the fee-delivery DoS scenario.
contract MockVault {
    bool public rejectEth;
    uint256 public received;

    function setRejectEth(bool reject) external {
        rejectEth = reject;
    }

    receive() external payable {
        if (rejectEth) revert("MockVault: rejected");
        received += msg.value;
    }
}

/// @dev Vault that tries to re-enter `flush()` while receiving ETH.
contract ReentrantVault {
    WarchestHook public hook;
    bool public attempted;
    bool public innerSucceeded;

    function setHook(WarchestHook hook_) external {
        hook = hook_;
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try hook.flush() returns (uint256) {
                innerSucceeded = true;
            } catch {
                innerSucceeded = false;
            }
        }
    }
}

/// @dev Shared setup: token, hook mined at a flag-compatible address, a hooked pool and an identical hook-less
///      reference pool. Works with a fresh local PoolManager (Deployers) or a forked mainnet PoolManager.
abstract contract WarchestHookFixture is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint24 internal constant LP_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    /// @dev Widest range that is a multiple of TICK_SPACING.
    int24 internal constant FULL_LOWER = -887_220;
    int24 internal constant FULL_UPPER = 887_220;

    WarchestToken internal token;
    WarchestHook internal hook;
    PoolKey internal hookedKey;
    PoolKey internal refKey;
    PoolId internal hookedId;

    // ------------------------------------------------------------------ deployment

    function _deployRouters() internal {
        swapRouter = new PoolSwapTest(manager);
        modifyLiquidityRouter = new PoolModifyLiquidityTest(manager);
    }

    /// @dev Deploys the token and the hook (this contract is the pool initializer) and prepares both pool keys.
    function _deployWarchest(address vault_) internal {
        token = new WarchestToken("Warchest", "WAR", SUPPLY, address(this));
        hook = _deployHook(address(token), vault_, address(this));

        hookedKey = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LP_FEE, TICK_SPACING, hook);
        refKey = PoolKey(
            CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LP_FEE, TICK_SPACING, IHooks(address(0))
        );
        hookedId = hookedKey.toId();

        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
    }

    /// @dev Mines a salt with this contract as CREATE2 deployer and deploys the hook.
    function _deployHook(address token_, address vault_, address initializer_) internal returns (WarchestHook h) {
        bytes memory args = abi.encode(manager, token_, vault_, initializer_);
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), HOOK_FLAGS, type(WarchestHook).creationCode, args);
        h = new WarchestHook{salt: salt}(manager, token_, vault_, initializer_);
        require(address(h) == expected, "fixture: hook address mismatch");
    }

    function _initPools(uint160 sqrtPriceX96) internal {
        manager.initialize(hookedKey, sqrtPriceX96);
        manager.initialize(refKey, sqrtPriceX96);
    }

    /// @dev Adds the same position to both pools. `ethBudget` is forwarded and the router refunds the surplus.
    function _addLiquidityBoth(int24 lower, int24 upper, int256 liquidity, uint256 ethBudget) internal {
        _addLiquidity(hookedKey, lower, upper, liquidity, ethBudget);
        _addLiquidity(refKey, lower, upper, liquidity, ethBudget);
    }

    function _addLiquidity(PoolKey memory k, int24 lower, int24 upper, int256 liquidity, uint256 ethBudget)
        internal
        returns (BalanceDelta)
    {
        return modifyLiquidityRouter.modifyLiquidity{value: ethBudget}(
            k, ModifyLiquidityParams(lower, upper, liquidity, 0), ""
        );
    }

    // ------------------------------------------------------------------ swaps (through PoolSwapTest)

    function _swap(PoolKey memory k, bool zeroForOne, int256 amountSpecified, uint160 limit, uint256 value)
        internal
        returns (BalanceDelta)
    {
        return swapRouter.swap{value: value}(
            k, SwapParams(zeroForOne, amountSpecified, limit), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    /// @dev BUY exactIn: pay exactly `ethIn`.
    function _buyExactIn(PoolKey memory k, uint256 ethIn) internal returns (BalanceDelta) {
        return _swap(k, true, -int256(ethIn), MIN_PRICE_LIMIT, ethIn);
    }

    /// @dev BUY exactOut: receive exactly `tokenOut`, paying at most `ethBudget` (surplus refunded by the router).
    function _buyExactOut(PoolKey memory k, uint256 tokenOut, uint256 ethBudget) internal returns (BalanceDelta) {
        return _swap(k, true, int256(tokenOut), MIN_PRICE_LIMIT, ethBudget);
    }

    /// @dev SELL exactIn: pay exactly `tokenIn`.
    function _sellExactIn(PoolKey memory k, uint256 tokenIn) internal returns (BalanceDelta) {
        return _swap(k, false, -int256(tokenIn), MAX_PRICE_LIMIT, 0);
    }

    /// @dev SELL exactOut: receive exactly `ethOut` net.
    function _sellExactOut(PoolKey memory k, uint256 ethOut) internal returns (BalanceDelta) {
        return _swap(k, false, int256(ethOut), MAX_PRICE_LIMIT, 0);
    }

    // ------------------------------------------------------------------ expected fee (independent of the hook)

    /// @dev ceil(x * 10%).
    function _feeOnGross(uint256 gross) internal pure returns (uint256) {
        return (gross * 1000 + 9999) / 10_000;
    }

    /// @dev ceil(x * 10% / 90%) = ceil(x / 9).
    function _feeOnNet(uint256 net) internal pure returns (uint256) {
        return (net * 1000 + 8999) / 9000;
    }

    // ------------------------------------------------------------------ revert helpers

    /// @dev The PoolManager wraps hook reverts in `CustomRevert.WrappedError`.
    function _hookRevert(bytes4 hookFn, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFn,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _expectHookRevert(bytes4 hookFn, bytes memory reason) internal {
        vm.expectRevert(_hookRevert(hookFn, reason));
    }

    /// @dev Asserts that `err` is a WrappedError from `hookFn` whose inner reason starts with `reasonSelector`.
    function _assertHookRevert(bytes memory err, bytes4 hookFn, bytes4 reasonSelector) internal view {
        assertEq(bytes4(err), CustomRevert.WrappedError.selector, "not a WrappedError");
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (address target, bytes4 fn, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        assertEq(target, address(hook), "wrong revert target");
        assertEq(fn, hookFn, "wrong hook function");
        assertEq(bytes4(reason), reasonSelector, "wrong hook error");
    }

    // ------------------------------------------------------------------ state helpers

    function _sqrtPrice(PoolKey memory k) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(k.toId());
    }

    function _liquidity(PoolKey memory k) internal view returns (uint128) {
        return manager.getLiquidity(k.toId());
    }
}
