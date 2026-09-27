// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {WarchestVaultForkFixture, ForkSwapper} from "./WarchestVaultFork.t.sol";

/// @notice Review M1 on the REAL pool: a one-shot dump barely moves the 30 min TWAP (covered by the sandwich test),
///         but a dump HELD for the whole window drags the TWAP, hence the floor, to the manipulated price. The
///         6 h circuit breaker refuses the conversion in that state and lets it through in normal conditions.
contract WarchestVaultOracleForkTest is WarchestVaultForkFixture {
    /// Dumps ETH until the spot tick is at least `ticks` under `reference`.
    function _dumpUntil(ForkSwapper s, int24 ref, int24 ticks) internal returns (int24 spot) {
        for (uint256 i; i < 25; ++i) {
            s.sellEth(2_000 ether);
            (, spot,,,,,) = POOL.slot0();
            if (spot < ref - ticks) break;
        }
        assertLt(spot, ref - ticks, "could not push the price far enough");
    }

    /// Reviewer's PoC turned into a regression: hold a dump for > twapWindow, the short TWAP floor collapses to
    /// the held price while the 6 h TWAP barely moves, and the breaker refuses to sell.
    function test_fork_heldDumpTripsOracleBreaker() public onlyFork {
        _fund(1 ether);
        int24 twapBefore = vault.twapTick();
        int24 longBefore = vault.longTwapTick();
        uint256 floorBefore = vault.twapFloor(1 ether);
        int24 maxDev = vault.maxTwapDeviationTicks();
        assertTrue(vault.oracleStable(), "normal conditions at the fork block (after settling)");

        ForkSwapper s = new ForkSwapper(POOL, WETH);
        vm.deal(address(s), 50_000 ether);
        int24 spot = _dumpUntil(s, twapBefore, 2 * maxDev); // ≥ 4% under the TWAP
        // same block: neither TWAP moved, the floor is the honest one, the sandwich guard handles this case
        assertEq(vault.twapTick(), twapBefore);
        assertTrue(vault.oracleStable());

        // the attacker HOLDS the price for the whole short window (no arbitrage on the fork)
        vm.warp(vm.getBlockTimestamp() + TWAP_WINDOW + 1 minutes);
        int24 twapHeld = vault.twapTick();
        int24 longHeld = vault.longTwapTick();
        uint256 floorHeld = vault.twapFloor(1 ether);
        console2.log("spot after dump / 30m TWAP held / 6h TWAP");
        console2.logInt(spot);
        console2.logInt(twapHeld);
        console2.logInt(longHeld);
        console2.log("floor before / floor held (USDG per ETH x1e6)", floorBefore, floorHeld);
        assertLe(twapHeld, spot + 1, "the short TWAP is now the held price");
        assertLt(floorHeld * 100, floorBefore * 97, "the short-TWAP floor collapsed by more than 3%");
        assertGt(longHeld, twapHeld + maxDev, "the 6 h TWAP did not follow");
        assertLe(longBefore - longHeld, maxDev, "6 h TWAP moved by less than the tolerated deviation");

        assertFalse(vault.oracleStable());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.OracleDeviation.selector, twapHeld, longHeld, maxDev));
        vault.convertEthToUsdg(1 ether, floorHeld);
        assertEq(address(vault).balance, 1 ether, "nothing sold at the manipulated floor");

        // the breaker is a delay, not a lock: once the price has been held for the long window it IS the market
        vm.warp(vm.getBlockTimestamp() + vault.LONG_TWAP_WINDOW());
        assertTrue(vault.oracleStable());
    }

    /// Normal market: the two TWAPs agree within the tolerance and a conversion goes through.
    function test_fork_normalConditionsPassBreaker() public onlyFork {
        int24 short_ = vault.twapTick();
        int24 long_ = vault.longTwapTick();
        console2.log("30m TWAP / 6h TWAP tick at the fork block (after settling if needed)");
        console2.logInt(short_);
        console2.logInt(long_);
        console2.log("raw deviation at the fork block (ticks)", rawDeviationAtFork);
        assertTrue(vault.oracleStable());
        _fund(1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        assertGe(vault.convertEthToUsdg(1 ether, floor), floor);
    }
}
