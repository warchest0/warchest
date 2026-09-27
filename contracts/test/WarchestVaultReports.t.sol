// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WarchestVault} from "../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice S3.3: keeper reports with guardian challenge window, close-vote gate, close flow with on-chain measured
///         returns, realized PnL, high-water mark and the (disabled by default) distribution hook point.
contract WarchestVaultReportsTest is VaultFixture {
    event PositionReported(uint256 indexed decisionId, uint256 equity, uint64 reportedAt, uint64 finalAt);
    event ReportRevoked(uint256 indexed decisionId, uint256 equity);
    event CloseReported(uint256 indexed decisionId, uint64 reportedAt, uint64 finalAt);
    event CloseReportRevoked(uint256 indexed decisionId);
    event PositionClosed(
        uint256 indexed decisionId, uint256 capital, uint256 returned, int256 pnl, int256 cumulativePnl
    );
    event LateReturn(uint256 indexed decisionId, uint256 amount, int256 cumulativePnl);
    event Donation(uint256 amount);
    event Distributed(address indexed to, uint256 amount, uint256 highWaterMark);

    uint256 id;
    uint256 capital;

    function setUp() public {
        _deployVault();
        (id, capital) = _openPosition();
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// Simulates the return path: USDC bridged back lands as USDG in the vault (a relayer fill on Robinhood Chain).
    function _return(uint256 amount) internal {
        usdg.mint(address(vault), amount);
    }

    function _report(uint256 equity) internal {
        vm.prank(keeper);
        vault.reportPosition(id, equity);
    }

    function _closeWith(uint256 returned) internal {
        vm.prank(keeper);
        vault.reportClosed(id);
        _return(returned);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(id);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Equity reports
    // ---------------------------------------------------------------------------------------------------------------

    function test_report_happyPath() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionReported(id, 60_000e6, _now(), _now() + REPORT_WINDOW);
        _report(60_000e6);
        WarchestVault.Report memory r = vault.lastReport(id);
        assertEq(r.equity, 60_000e6);
        assertEq(r.reportedAt, vm.getBlockTimestamp());
        assertFalse(r.revoked);
        (uint256 eq, bool ok) = vault.finalizedEquity(id);
        assertFalse(ok);
        assertEq(eq, 0);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW - 1);
        (, ok) = vault.finalizedEquity(id);
        assertFalse(ok);
        vm.warp(vm.getBlockTimestamp() + 1);
        (eq, ok) = vault.finalizedEquity(id);
        assertTrue(ok);
        assertEq(eq, 60_000e6);
    }

    function test_report_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportPosition(id, 1);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportPosition(id, 1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NoSuchPosition.selector, id + 1));
        vault.reportPosition(id + 1, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NoSuchPosition.selector, 0));
        vault.reportPosition(0, 1);

        vm.prank(guardian);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.reportPosition(id, 1);
        vm.prank(guardian);
        vault.setPaused(false);

        vm.prank(keeper);
        vault.reportClosed(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionClosing.selector, id));
        vault.reportPosition(id, 1);
    }

    function test_report_replacementRestartsWindowAndKeepsMaturedOne() public {
        _report(50_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW); // matured
        _report(70_000e6); // replaces the pending slot, previous one is promoted
        (uint256 eq, bool ok) = vault.finalizedEquity(id);
        assertTrue(ok);
        assertEq(eq, 50_000e6, "matured report still counts while the new one is challengeable");
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        (eq, ok) = vault.finalizedEquity(id);
        assertEq(eq, 70_000e6);
    }

    function test_report_replacementBeforeMaturityDropsPrevious() public {
        _report(50_000e6);
        vm.warp(vm.getBlockTimestamp() + 1);
        _report(70_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW - 1); // first would have matured, but it was replaced
        (, bool ok) = vault.finalizedEquity(id);
        assertFalse(ok);
        vm.warp(vm.getBlockTimestamp() + 1);
        (uint256 eq,) = vault.finalizedEquity(id);
        assertEq(eq, 70_000e6);
    }

    function test_revokeReport_withinWindow() public {
        _report(50_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        _report(999_999e6); // bogus
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW - 1);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ReportRevoked(id, 999_999e6);
        vm.prank(guardian);
        vault.revokeReport(id);
        assertTrue(vault.lastReport(id).revoked);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        (uint256 eq, bool ok) = vault.finalizedEquity(id);
        assertTrue(ok);
        assertEq(eq, 50_000e6, "falls back to the last matured report");
    }

    function test_revokeReport_reverts() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportNotRevocable.selector, id));
        vault.revokeReport(id); // nothing reported

        _report(1e6);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.revokeReport(id);

        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportNotRevocable.selector, id));
        vault.revokeReport(id); // window elapsed

        _report(2e6);
        vm.prank(guardian);
        vault.revokeReport(id);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportNotRevocable.selector, id));
        vault.revokeReport(id); // twice
    }

    function test_revokedReportNeverCounts_newReportStartsFresh() public {
        _report(999_999e6);
        vm.prank(guardian);
        vault.revokeReport(id);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        (, bool ok) = vault.finalizedEquity(id);
        assertFalse(ok);
        _report(55_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        (uint256 eq,) = vault.finalizedEquity(id);
        assertEq(eq, 55_000e6);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // closeVoteAllowed
    // ---------------------------------------------------------------------------------------------------------------

    function _threshold() internal view returns (uint256) {
        return capital + capital * TAKE_PROFIT_BPS / BPS;
    }

    function test_closeVoteAllowed_requiresMaturedReportAtThreshold() public {
        assertFalse(vault.closeVoteAllowed(id));
        _report(_threshold());
        assertFalse(vault.closeVoteAllowed(id), "pending report does not count");
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        assertTrue(vault.closeVoteAllowed(id));

        _report(_threshold() - 1);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        assertFalse(vault.closeVoteAllowed(id), "below threshold");
    }

    function test_closeVoteAllowed_falseWhenMustCloseAnyway() public {
        _report(_threshold() * 2);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        assertTrue(vault.closeVoteAllowed(id));

        vm.prank(guardian);
        vault.setPaused(true);
        assertFalse(vault.closeVoteAllowed(id), "paused");
        vm.prank(guardian);
        vault.setPaused(false);

        gov.setCloseRequested(id, true);
        assertFalse(vault.closeVoteAllowed(id), "already requested");
        gov.setCloseRequested(id, false);

        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        assertFalse(vault.closeVoteAllowed(id), "superseded");
    }

    function test_closeVoteAllowed_falseWhileClosingOrWrongId() public {
        _report(_threshold() * 2);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        assertFalse(vault.closeVoteAllowed(0));
        assertFalse(vault.closeVoteAllowed(id + 1));
        vm.prank(keeper);
        vault.reportClosed(id);
        assertFalse(vault.closeVoteAllowed(id));
    }

    function testFuzz_closeVoteAllowed_neverReverts(uint256 anyId, uint256 equity, uint32 warpBy) public {
        vm.prank(keeper);
        vault.reportPosition(id, equity);
        vm.warp(vm.getBlockTimestamp() + warpBy);
        vault.closeVoteAllowed(anyId);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Close flow
    // ---------------------------------------------------------------------------------------------------------------

    function test_reportClosed_happyPath() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit CloseReported(id, _now(), _now() + REPORT_WINDOW);
        vm.prank(keeper);
        vault.reportClosed(id);
        assertEq(vault.position().closeReportedAt, vm.getBlockTimestamp());
        assertEq(vault.position().decisionId, id, "still recorded until finalized");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionClosing.selector, id));
        vault.reportClosed(id);
    }

    function test_reportClosed_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportClosed(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NoSuchPosition.selector, id + 1));
        vault.reportClosed(id + 1);
    }

    function test_reportClosed_allowedWhilePaused() public {
        vm.prank(guardian);
        vault.setPaused(true);
        assertTrue(vault.mustClose());
        vm.prank(keeper);
        vault.reportClosed(id);
        _return(capital);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(id);
        assertEq(vault.position().decisionId, 0);
    }

    function test_finalizeClose_revertsBeforeWindow() public {
        vm.prank(keeper);
        vault.reportClosed(id);
        uint256 finalAt = vm.getBlockTimestamp() + REPORT_WINDOW;
        vm.warp(finalAt - 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ChallengeWindowOpen.selector, finalAt));
        vault.finalizeClose(id);
    }

    function test_finalizeClose_revertsWhenNotClosing() public {
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NotClosing.selector, id));
        vault.finalizeClose(id);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NotClosing.selector, 0));
        vault.finalizeClose(0);
    }

    function test_finalizeClose_profit() public {
        uint256 ledgerBefore = vault.usdgLedger();
        vm.prank(keeper);
        vault.reportClosed(id);
        _return(capital + 5_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionClosed(id, capital, capital + 5_000e6, 5_000e6, 5_000e6);
        vm.prank(attacker); // permissionless
        vault.finalizeClose(id);

        assertEq(vault.position().decisionId, 0);
        assertEq(vault.usdgLedger(), ledgerBefore + capital + 5_000e6);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
        assertEq(vault.cumulativePnl(), 5_000e6);
        assertEq(vault.lastClosedDecisionId(), id);
        assertEq(vault.distributable(), 5_000e6);
        assertFalse(vault.mustClose());
    }

    function test_finalizeClose_loss() public {
        _closeWith(capital / 2);
        assertEq(vault.cumulativePnl(), -int256(capital - capital / 2));
        assertEq(vault.distributable(), 0);
    }

    /// Liquidated / stopped out with nothing left: nothing comes back, PnL = −capital, the vault keeps working.
    function test_finalizeClose_nothingReturned_vaultNotBricked() public {
        uint256 ledger = vault.usdgLedger();
        _closeWith(0);
        assertEq(vault.cumulativePnl(), -int256(capital));
        assertEq(vault.usdgLedger(), ledger);
        assertEq(vault.position().decisionId, 0);
        // next decision executes against the remaining liquid NAV
        gov.nextDecision(ETH_ASSET, IWarchestDecisionSource.Side.Short);
        uint256 next = vault.maxOrderAmount();
        assertGt(next, 0);
        _execute(next);
        assertEq(vault.position().decisionId, id + 1);
        assertEq(vault.position().capital, next);
    }

    /// Nobody filled the Across deposit: the SpokePool refunds the depositor (the vault). PnL = 0.
    function test_finalizeClose_expiredDepositRefund() public {
        vm.prank(keeper);
        vault.reportClosed(id);
        spoke.release(address(usdg), address(vault), capital);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(id);
        assertEq(vault.cumulativePnl(), 0);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
    }

    function test_finalizeClose_countsEverythingReturnedBeforeFinalization() public {
        _return(1_000e6); // arrived before the keeper even reported
        vm.prank(keeper);
        vault.reportClosed(id);
        _return(2_000e6);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        _return(3_000e6);
        vault.finalizeClose(id);
        assertEq(vault.cumulativePnl(), int256(6_000e6) - int256(capital));
    }

    function test_revokeCloseReport_restoresOpenPosition() public {
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW - 1);
        vm.expectEmit(true, false, false, true, address(vault));
        emit CloseReportRevoked(id);
        vm.prank(guardian);
        vault.revokeCloseReport(id);
        assertEq(vault.position().closeReportedAt, 0);
        assertEq(vault.position().decisionId, id);
        _report(1e6); // open again
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NotClosing.selector, id));
        vault.finalizeClose(id);
    }

    function test_revokeCloseReport_reverts() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NotClosing.selector, id));
        vault.revokeCloseReport(id);
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.revokeCloseReport(id);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportNotRevocable.selector, id));
        vault.revokeCloseReport(id);
    }

    function test_afterClose_oldIdRejectedEverywhere() public {
        _closeWith(capital);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NoSuchPosition.selector, id));
        vault.reportPosition(id, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NoSuchPosition.selector, id));
        vault.reportClosed(id);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.NotClosing.selector, id));
        vault.finalizeClose(id);
        assertFalse(vault.closeVoteAllowed(id));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reconcile
    // ---------------------------------------------------------------------------------------------------------------

    function test_reconcile_lateReturnAddsPnl() public {
        _closeWith(capital / 2);
        _return(capital / 2 + 1_000e6); // the second Across chunk arrives later
        vm.expectEmit(true, false, false, true, address(vault));
        emit LateReturn(id, capital / 2 + 1_000e6, 1_000e6);
        vm.prank(keeper);
        vault.reconcile();
        assertEq(vault.cumulativePnl(), 1_000e6);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
        assertEq(vault.distributable(), 1_000e6);
    }

    function test_reconcile_donationBeforeAnyClose() public {
        _deployVault(); // fresh vault, nothing ever closed
        usdg.mint(address(vault), 500e6);
        vm.expectEmit(false, false, false, true, address(vault));
        emit Donation(500e6);
        vm.prank(keeper);
        vault.reconcile();
        assertEq(vault.cumulativePnl(), 0);
        assertEq(vault.usdgLedger(), 500e6);
        assertEq(vault.distributable(), 0);
    }

    function test_reconcile_reverts() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionOpen.selector, id));
        vault.reconcile();
        _closeWith(capital);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NothingToReconcile.selector);
        vault.reconcile();
        _return(1);
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reconcile();
    }

    function test_reconcile_makesStrayUsdgUsableForOrders() public {
        _closeWith(capital);
        _return(1_000_000e6);
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 max = vault.maxOrderAmount();
        uint256 ledger = vault.usdgLedger();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.LedgerInsufficient.selector, max, ledger));
        vault.executeDecision(max, max, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + FILL_WINDOW);
        vm.prank(keeper);
        vault.reconcile();
        _execute(max);
        assertEq(vault.position().capital, max);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // High-water mark & distribution hook
    // ---------------------------------------------------------------------------------------------------------------

    function test_distributable_zeroWhilePositionOpen() public {
        _closeWith(capital + 10_000e6);
        assertEq(vault.distributable(), 10_000e6);
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        assertEq(vault.distributable(), 0);
        vm.prank(distributor);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExceedsDistributable.selector, 1, 0));
        vault.pullDistributable(1);
    }

    function test_pullDistributable_raisesHighWaterMark() public {
        _closeWith(capital + 10_000e6);
        uint256 ledger = vault.usdgLedger();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Distributed(distributor, 4_000e6, 4_000e6);
        vm.prank(distributor);
        vault.pullDistributable(4_000e6);
        assertEq(vault.highWaterMark(), 4_000e6);
        assertEq(vault.distributable(), 6_000e6);
        assertEq(usdg.balanceOf(distributor), 4_000e6);
        assertEq(vault.usdgLedger(), ledger - 4_000e6);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
        vm.prank(distributor);
        vault.pullDistributable(6_000e6);
        assertEq(vault.highWaterMark(), 10_000e6);
        assertEq(vault.distributable(), 0);
        vm.prank(distributor);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExceedsDistributable.selector, 1, 0));
        vault.pullDistributable(1);
    }

    function test_pullDistributable_reverts() public {
        _closeWith(capital + 10_000e6);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);
        vm.prank(distributor);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExceedsDistributable.selector, 0, 10_000e6));
        vault.pullDistributable(0);
        vm.prank(distributor);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExceedsDistributable.selector, 10_000e6 + 1, 10_000e6));
        vault.pullDistributable(10_000e6 + 1);
        vm.prank(guardian);
        vault.setPaused(true);
        vm.prank(distributor);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.pullDistributable(1);
    }

    function test_pullDistributable_disabledWhenNoDistributor() public {
        _deployVenue();
        vault = new WarchestVault(
            guardian, keeper, gov, address(0), _venue(), _bridge(), _conversionParams(), _orderParams()
        );
        assertEq(vault.distributor(), address(0));
        (id, capital) = _openPosition();
        _closeWith(capital + 10_000e6);
        assertEq(vault.distributable(), 10_000e6, "visible, but nobody can pull it");
        vm.prank(address(0));
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);
        vm.prank(distributor);
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(1);
    }

    /// Classic HWM: after a distribution, a loss must be fully recovered before anything is distributable again.
    function test_highWaterMark_lossMustBeRecoveredFirst() public {
        _closeWith(capital + 10_000e6);
        vm.prank(distributor);
        vault.pullDistributable(10_000e6);

        // position 2 loses 4 000
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        id = vault.lastExecutedDecisionId() + 1;
        _execute(20_000e6);
        capital = 20_000e6;
        _closeWith(16_000e6);
        assertEq(vault.cumulativePnl(), 6_000e6);
        assertEq(vault.highWaterMark(), 10_000e6);
        assertEq(vault.distributable(), 0);

        // position 3 makes 6 000: only 2 000 above the mark
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        id = vault.lastExecutedDecisionId() + 1;
        _execute(20_000e6);
        _closeWith(26_000e6);
        assertEq(vault.cumulativePnl(), 12_000e6);
        assertEq(vault.distributable(), 2_000e6);
        assertEq(vault.highWaterMark(), 10_000e6, "the mark only moves on distribution");
    }
}
