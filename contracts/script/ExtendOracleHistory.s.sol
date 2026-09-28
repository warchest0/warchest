// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IUniswapV3PoolOracle {
    function slot0()
        external
        view
        returns (uint160, int24, uint16 observationIndex, uint16 cardinality, uint16 cardinalityNext, uint8, bool);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/// @title ExtendOracleHistory
/// @notice Grows the price-history buffer of the WETH/USDG Uniswap v3 pool the vault reads its TWAPs from.
/// @dev The vault's oracle circuit breaker needs `LONG_TWAP_WINDOW` (6 h) of history. The buffer holds a fixed number
///      of observations (10,809 on 2026-09-28), so the time it covers shrinks when the pool gets busier (≈ 44 h on
///      2026-09-27, ≈ 11 h on 2026-09-28). Below 6 h, `convertEthToUsdg` reverts (fail-closed, no funds at risk).
///      Growing the buffer is permissionless; measured cost ≈ 22.4k gas per slot (≈ $1.5 per 1,000 slots at
///      0.025 gwei). New slots only fill as swaps happen, so extend ahead of need.
///      Env: `TARGET_CARDINALITY` (required), `CHUNK` [2000] slots per transaction, `POOL` [mainnet WETH/USDG 0.01%].
///      `forge script script/ExtendOracleHistory.s.sol --rpc-url robinhood --account <keystore> --broadcast`
contract ExtendOracleHistory is Script {
    function run() external {
        IUniswapV3PoolOracle pool =
            IUniswapV3PoolOracle(vm.envOr("POOL", address(0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca)));
        uint256 target = vm.envUint("TARGET_CARDINALITY");
        uint256 chunk = vm.envOr("CHUNK", uint256(2000));
        require(target <= type(uint16).max, "target too large");

        (,,, uint16 cardinality, uint16 next,,) = pool.slot0();
        console2.log("cardinality / next:", cardinality, next);
        vm.startBroadcast();
        for (uint256 c = next; c < target;) {
            c = c + chunk > target ? target : c + chunk;
            pool.increaseObservationCardinalityNext(uint16(c));
            console2.log("cardinalityNext ->", c);
        }
        vm.stopBroadcast();
    }
}
