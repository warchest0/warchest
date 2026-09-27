// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WarchestVault} from "../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice Adversarial suite: the keeper key is stolen. Whatever the attacker does, funds only ever leave towards
///         the pool (bounded by the TWAP floor) and the SpokePool for the immutable recipient (≤ cap, once per
///         decision); reports cannot move funds; the guardian can revoke, pause and rotate, and never touches funds.
contract WarchestVaultMaliciousKeeperTest is VaultFixture {
    function setUp() public {
        _deployVault();
        _fund(attacker, 200 ether);
    }

    function _balancesSnapshot() internal view returns (uint256 eth, uint256 usdgBal, uint256 ledger) {
        return (address(vault).balance, usdg.balanceOf(address(vault)), vault.usdgLedger());
    }

    /// End-to-end: everything a stolen keeper key can try, and the ceiling of the damage.
    function test_stolenKey_worstCaseIsBounded() public {
        uint256 ethBefore = address(vault).balance;
        uint256 twapValue = vault.quoteEthInUsdg(ethBefore);

        // 1. dump ETH at the worst price the guard allows, as fast as the cooldown allows
        pool.setExecTick(TICK - 100); // ≈ −0.995%, just inside the 1% band
        uint256 converted;
        while (address(vault).balance > 0) {
            uint256 amt = address(vault).balance < MAX_CONVERT ? address(vault).balance : MAX_CONVERT;
            converted += _convert(amt, vault.twapFloor(amt));
            vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        }
        assertGe(converted, twapValue * (BPS - MAX_SLIPPAGE_BPS) / BPS, "ETH never sold below TWAP x 0.99");
        assertEq(usdg.balanceOf(address(vault)), converted, "all proceeds are in the vault");

        // 2. bridge the max, once, to the immutable recipient
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 navBefore = vault.nav();
        uint256 cap = vault.maxOrderAmount();
        assertEq(cap, navBefore * 2_000 / 10_000);
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.CapExceeded.selector, cap + 1, cap));
        vault.executeDecision(
            cap + 1, cap + 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours
        );
        vault.executeDecision(cap, cap, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, id, id));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(spoke)), cap);
        assertEq(usdg.balanceOf(address(vault)), converted - cap);

        // 3. lie about the equity to trigger a close vote: the guardian revokes inside the window
        vm.prank(keeper);
        vault.reportPosition(id, cap * 100);
        vm.prank(guardian);
        vault.revokeReport(id);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        assertFalse(vault.closeVoteAllowed(id));

        // 4. declare the position closed while nothing came back: the guardian revokes
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.prank(guardian);
        vault.revokeCloseReport(id);
        assertEq(vault.position().closeReportedAt, 0);

        // 5. guardian pauses and rotates the keeper: the attacker is locked out, funds untouched
        vm.prank(guardian);
        vault.setPaused(true);
        assertTrue(vault.mustClose());
        address newKeeper = makeAddr("newKeeper");
        vm.prank(guardian);
        vault.setKeeper(newKeeper);
        vm.startPrank(keeper);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(1, 0);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportPosition(id, 1);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportClosed(id);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reconcile();
        vm.expectRevert(WarchestVault.IsPaused.selector); // and NotDistributor once unpaused
        vault.pullDistributable(1);
        vm.stopPrank();
        vm.prank(guardian);
        vault.setPaused(false);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);

        // ceiling of the damage: ≤ 1% of the ETH value (conversion) + ≤ 20% of the NAV parked at the SpokePool for
        // the immutable recipient. Nothing anywhere else.
        assertEq(usdg.balanceOf(address(vault)) + usdg.balanceOf(address(spoke)), converted);
        assertEq(usdg.balanceOf(keeper), 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(keeper.balance, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        assertLe(cap * BPS, navBefore * 2_000);
    }

    /// Reports are information only: no combination of reports changes a balance or creates distributable value.
    function test_reportsCannotCreateValue() public {
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 cap = vault.maxOrderAmount();
        _execute(cap);
        (uint256 e0, uint256 u0, uint256 l0) = _balancesSnapshot();

        vm.startPrank(keeper);
        vault.reportPosition(id, type(uint256).max);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.reportPosition(id, 0);
        vault.reportClosed(id); // nothing came back
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(id);

        (uint256 e1, uint256 u1, uint256 l1) = _balancesSnapshot();
        assertEq(e1, e0);
        assertEq(u1, u0);
        assertEq(l1, l0);
        assertEq(vault.cumulativePnl(), -int256(cap), "declared close without funds = realized loss, not profit");
        assertEq(vault.distributable(), 0);
    }

    /// An early close report lets the keeper re-execute after the window, but the position must first be
    /// `reportChallengeWindow` old, a close that brought nothing back delays the next order by another window, and
    /// each execution is still ≤ cap of the liquid NAV and needs a NEW governance decision.
    function test_earlyCloseCannotBypassCapOrDecisionRule() public {
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 cap1 = vault.maxOrderAmount();
        _execute(cap1);
        uint256 closableAt = vm.getBlockTimestamp() + REPORT_WINDOW;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionTooYoung.selector, id, closableAt));
        vault.reportClosed(id);
        vm.warp(closableAt);
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(id);
        uint256 nextExecuteAt = vm.getBlockTimestamp() + REPORT_WINDOW;
        assertEq(vault.nextExecuteAt(), nextExecuteAt, "nothing came back: cooldown before the next order");

        // same decision: blocked
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, id, id));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);

        // new decision: cooldown first, then cap is 20% of what is LEFT, deployed capital never counts
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExecuteCooldown.selector, nextExecuteAt));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        vm.warp(nextExecuteAt);
        uint256 cap2 = vault.maxOrderAmount();
        assertLt(cap2, cap1);
        assertEq(cap2, vault.nav() * 2_000 / 10_000);
        // the ledger (USDG actually on hand) is a second bound: unconverted ETH counts in the NAV, not in the ledger
        uint256 ledger = vault.usdgLedger();
        uint256 amount2 = cap2 < ledger ? cap2 : ledger;
        _execute(amount2);
        assertEq(usdg.balanceOf(address(spoke)), cap1 + amount2);
    }

    /// The bridge fee bound caps the value a colluding relayer could skim.
    function test_bridgeFeeLeakBounded() public {
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 cap = vault.maxOrderAmount();
        uint256 minOut = cap * (BPS - MAX_BRIDGE_FEE_BPS) / BPS;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.BridgeFeeTooHigh.selector, minOut - 1, minOut));
        vault.executeDecision(cap, minOut - 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        vm.prank(keeper);
        vault.executeDecision(cap, minOut, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours);
        assertLe(cap - minOut, cap * MAX_BRIDGE_FEE_BPS / BPS + 1); // floor rounding of minOut
    }

    /// Report spam after a revocation is stopped by the pause.
    function test_reportSpam_stoppedByPause() public {
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(vault.maxOrderAmount());
        for (uint256 i; i < 3; ++i) {
            vm.prank(keeper);
            vault.reportPosition(id, 1e30);
            vm.prank(guardian);
            vault.revokeReport(id);
        }
        vm.prank(guardian);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.reportPosition(id, 1e30);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertFalse(vault.closeVoteAllowed(id));
    }

    /// Every guardian power leaves every balance exactly where it was.
    function test_guardianNeverDecreasesBalances() public {
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        vm.prank(keeper);
        vault.reportPosition(id, 1);
        (uint256 e0, uint256 u0, uint256 l0) = _balancesSnapshot();
        uint256 spoke0 = usdg.balanceOf(address(spoke));

        vm.startPrank(guardian);
        vault.setPaused(true);
        vault.setPaused(false);
        vault.revokeReport(id);
        vault.setKeeper(makeAddr("k2"));
        vault.setKeeper(keeper);
        vault.transferGuardian(makeAddr("g2"));
        vault.transferGuardian(guardian);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW); // minimum position age
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.prank(guardian);
        vault.revokeCloseReport(id);

        (uint256 e1, uint256 u1, uint256 l1) = _balancesSnapshot();
        assertEq(e1, e0);
        assertEq(u1, u0);
        assertEq(l1, l0);
        assertEq(usdg.balanceOf(address(spoke)), spoke0);
        assertEq(usdg.balanceOf(guardian), 0);
        assertEq(guardian.balance, 0);
        assertEq(vault.position().decisionId, id);
        assertEq(vault.bridgeRecipient(), hlAccount);
    }
}
