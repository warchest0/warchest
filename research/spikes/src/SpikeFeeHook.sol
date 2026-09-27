// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// SPIKE ONLY — throwaway code to measure gas. Not production, not audited.

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BaseTestHooks} from "@uniswap/v4-core/src/test/BaseTestHooks.sol";

/// 10% fee, always taken in native ETH (currency0), sent to `vault`.
contract SpikeFeeHook is BaseTestHooks {
    IPoolManager public immutable manager;
    address public immutable vault;
    uint256 internal constant FEE_BPS = 1000;

    constructor(IPoolManager _manager, address _vault) {
        manager = _manager;
        vault = _vault;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x < 0 ? -x : x);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(manager));
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        if (!specifiedIs0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 fee = _abs(params.amountSpecified) * FEE_BPS / 10_000;
        manager.take(key.currency0, vault, fee);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        require(msg.sender == address(manager));
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        if (specifiedIs0) return (IHooks.afterSwap.selector, 0);
        uint256 fee = _abs(delta.amount0()) * FEE_BPS / 10_000;
        manager.take(key.currency0, vault, fee);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }
}
