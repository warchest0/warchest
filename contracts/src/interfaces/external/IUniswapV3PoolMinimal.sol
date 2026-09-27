// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IUniswapV3PoolMinimal
/// @notice The subset of the Uniswap v3 pool ABI used by WarchestVault (verified against the WETH/USDG 0.01% pool
///         `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` on Robinhood Chain 4663).
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Oracle read: cumulative tick and seconds-per-liquidity at each `secondsAgos[i]` before now.
    ///         Reverts with "OLD" when the requested window exceeds the stored history.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    /// @notice Swaps against the pool; the caller must implement {IUniswapV3SwapCallback} and pay the owed input
    ///         inside the callback. Returns the token deltas from the POOL's point of view (positive = paid to pool).
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title IUniswapV3SwapCallback
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}
