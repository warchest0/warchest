// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WarchestVault} from "../src/WarchestVault.sol";
import {WarchestDistributor, IWarchestVaultDistribution} from "../src/WarchestDistributor.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {DeploySystem} from "../script/DeploySystem.s.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice Regression tests for the adversarial review of the treasury contracts. Each test replays a reviewer PoC
///         and proves the fix: HIGH (distributor guardian steals funded profit), M1 (held TWAP manipulation),
///         M2 (external USDG booked as PnL), L1 (report spam suppresses close votes), L2 (fake-close cycling),
///         L3 (DeploySystem on the wrong chain).
contract WarchestVaultReviewRegressionTest is VaultFixture {
    uint64 constant TIMELOCK = 1 days;
    address updater = makeAddr("distUpdater");
    WarchestDistributor dist;
    uint256 decisionId;
    uint256 capital;

    function setUp() public {
        _deployVenue();
        dist = new WarchestDistributor(usdg, guardian, updater, TIMELOCK);
        distributor = address(dist);
        vault = _newVault(guardian, keeper, _venue(), _conversionParams());
        vm.prank(guardian);
        dist.setVault(IWarchestVaultDistribution(address(vault)));
        (decisionId, capital) = _openPosition();
    }

    function _closeWithReturn(uint256 returned) internal {
        vm.prank(keeper);
        vault.reportClosed(decisionId);
        usdg.mint(address(vault), returned); // bridged back
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(decisionId);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // HIGH — distributor guardian cannot become the updater and pay itself
    // ---------------------------------------------------------------------------------------------------------------

    /// PoC: `setUpdater(guardian)` was instant, so the guardian alone could publish a root paying itself every
    /// funded USDG. Now the rotation is a public `updaterDelay` (timelock + 3 days) and the root then waits its own
    /// timelock: the fastest possible self-payment is publicly announced for `updaterDelay + timelock` ≥ 5 days,
    /// during which the independent verifier sees both events and the guardian multisig can be challenged.
    function test_regression_distributorGuardianCannotStealFundedProfit() public {
        _closeWithReturn(capital + 10_000e6);
        assertEq(dist.fund(), 10_000e6);
        uint256 t0 = _now();

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = dist.leaf(guardian, 10_000e6);
        bytes32 root = MerkleHelper.root(leaves);

        vm.startPrank(guardian);
        vm.expectRevert(WarchestDistributor.NotUpdater.selector);
        dist.proposeRoot(root, 10_000e6, bytes32(0)); // the guardian is not the updater
        dist.proposeUpdater(guardian); // public: UpdaterChangeProposed(guardian, readyAt)
        vm.expectRevert(WarchestDistributor.NotUpdater.selector);
        dist.proposeRoot(root, 10_000e6, bytes32(0)); // still not, for updaterDelay
        vm.stopPrank();
        uint64 readyAt = dist.pendingUpdaterReadyAt();
        assertEq(readyAt, t0 + TIMELOCK + 3 days);
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestDistributor.UpdaterDelayNotElapsed.selector, readyAt));
        dist.applyUpdaterChange();

        // residual trust, documented: after the public notice the guardian CAN become the updater and its root
        // still needs the root timelock; nothing is claimable before t0 + updaterDelay + timelock
        vm.warp(readyAt);
        dist.applyUpdaterChange();
        vm.prank(guardian);
        dist.proposeRoot(root, 10_000e6, bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(WarchestDistributor.TimelockNotElapsed.selector, uint64(_now()) + TIMELOCK)
        );
        dist.acceptRoot();
        assertEq(usdg.balanceOf(guardian), 0);
        assertGe(_now() + TIMELOCK, t0 + dist.updaterDelay() + TIMELOCK);
        assertGe(dist.updaterDelay() + TIMELOCK, 5 days);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M1 — oracle circuit breaker
    // ---------------------------------------------------------------------------------------------------------------

    /// PoC (fork): a dump HELD for `twapWindow` drags the 30 min TWAP, hence the floor, to the manipulated price.
    /// Now the conversion refuses a short TWAP more than `2 × maxSlippageBps` ticks away from the 6 h TWAP.
    function test_regression_heldTwapManipulationTripsBreaker() public {
        _fund(attacker, 10 ether);
        uint256 ethBefore = address(vault).balance;
        vm.warp(_now() + COOLDOWN);
        int24 maxDev = vault.maxTwapDeviationTicks();
        assertEq(maxDev, int24(2 * int24(uint24(MAX_SLIPPAGE_BPS))));
        assertEq(vault.LONG_TWAP_WINDOW(), 6 hours);

        // held dump: spot and 30 min TWAP at −3%, 6 h TWAP still at the market
        pool.setShortTwapTick(TICK - 300);
        pool.setExecTick(TICK - 300);
        assertFalse(vault.oracleStable());
        uint256 floor = vault.twapFloor(1 ether); // the manipulated floor the keeper would be allowed to use
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.OracleDeviation.selector, TICK - 300, TICK, maxDev));
        vault.convertEthToUsdg(1 ether, floor);
        assertEq(address(vault).balance, ethBefore, "nothing sold");

        // a held pump is refused too (the oracle is not trustworthy either way)
        pool.setShortTwapTick(TICK + 300);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.OracleDeviation.selector, TICK + 300, TICK, maxDev));
        vault.convertEthToUsdg(1 ether, 0);

        // exactly at the bound: allowed; one tick beyond: refused
        pool.setShortTwapTick(TICK - maxDev);
        pool.setExecTick(TICK - maxDev);
        assertTrue(vault.oracleStable());
        pool.setShortTwapTick(TICK - maxDev - 1);
        assertFalse(vault.oracleStable());

        // the market really moved: the long TWAP follows and conversions resume at the new floor
        pool.setTwapTick(TICK - 300);
        assertTrue(vault.oracleStable());
        floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        uint256 out = vault.convertEthToUsdg(1 ether, floor);
        assertGe(out, floor);
    }

    function test_regression_twapWindowMustBeShorterThanLongWindow() public {
        WarchestVault.ConversionParams memory p = _conversionParams();
        p.twapWindow = 6 hours;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        _newVault(guardian, keeper, _venue(), p);
        p.twapWindow = 6 hours - 1;
        _newVault(guardian, keeper, _venue(), p);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M2 — external USDG is principal, never PnL
    // ---------------------------------------------------------------------------------------------------------------

    /// PoC: a 50k principal top-up landing during a close was booked as profit and paid out by the distributor.
    /// Now a top-up goes through `depositPrincipal` (accounted at once, never measured as a return) and, after a
    /// close, a stray amount can only restore that position's shortfall, inside a bounded window.
    function test_regression_principalTopUpNeverDistributed() public {
        address partner = makeAddr("partner");
        usdg.mint(partner, 51_000e6);
        vm.prank(partner);
        usdg.approve(address(vault), type(uint256).max);

        vm.prank(keeper);
        vault.reportClosed(decisionId);
        usdg.mint(address(vault), capital); // position came back flat
        vm.prank(partner);
        vault.depositPrincipal(50_000e6); // unrelated principal top-up during the close
        vm.warp(_now() + REPORT_WINDOW);
        vault.finalizeClose(decisionId);
        assertEq(vault.cumulativePnl(), 0, "top-up is not realized PnL");
        assertEq(vault.distributable(), 0);
        vm.expectRevert(WarchestDistributor.NothingToFund.selector);
        dist.fund();

        // after a flat close there is no shortfall: every stray is principal
        usdg.mint(address(vault), 1_000e6);
        vm.prank(keeper);
        vault.reconcile();
        assertEq(vault.cumulativePnl(), 0);
        assertEq(vault.distributable(), 0);
        vm.prank(partner);
        vault.depositPrincipal(1_000e6);
        assertEq(vault.distributable(), 0);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
    }

    /// Late returns: PnL only up to the shortfall and only inside `lateReturnWindow`; a stolen keeper key plus any
    /// inflow can never mint distributable profit.
    function test_regression_lateReturnBoundedByShortfallAndWindow() public {
        _closeWithReturn(capital / 2);
        uint256 shortfall = capital - capital / 2;
        usdg.mint(address(vault), shortfall + 5_000e6);
        vm.prank(keeper);
        vault.reconcile();
        assertEq(vault.cumulativePnl(), 0, "shortfall restored, profit part is principal");
        assertEq(vault.distributable(), 0);

        // a second short close, then the window expires: nothing can be PnL anymore
        vm.warp(vault.nextExecuteAt());
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        decisionId = vault.lastExecutedDecisionId() + 1;
        capital = vault.maxOrderAmount();
        _execute(capital);
        vm.warp(_now() + REPORT_WINDOW);
        _closeWithReturn(0);
        vm.warp(_now() + vault.lateReturnWindow() + 1);
        usdg.mint(address(vault), 10 * capital);
        vm.prank(keeper);
        vault.reconcile();
        assertEq(vault.cumulativePnl(), -int256(capital));
        assertEq(vault.distributable(), 0);
        vm.expectRevert(WarchestDistributor.NothingToFund.selector);
        dist.fund();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // L1 — the keeper cannot suppress take-profit votes
    // ---------------------------------------------------------------------------------------------------------------

    /// PoC: re-reporting every < window kept every report pending forever. Now a pending report cannot be replaced,
    /// so it matures on schedule and the close vote opens; only a guardian revocation allows a fresh one.
    function test_regression_keeperCannotSuppressCloseVotes() public {
        vm.prank(keeper);
        vault.reportPosition(decisionId, capital * 2);
        uint256 finalAt = _now() + REPORT_WINDOW;
        for (uint256 i; i < 10; ++i) {
            vm.warp(finalAt - 1 - i * 100);
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportPending.selector, decisionId, finalAt));
            vault.reportPosition(decisionId, 0);
        }
        vm.warp(finalAt);
        assertTrue(vault.closeVoteAllowed(decisionId), "the report matured despite the keeper");

        // a matured report can be followed by a lower one, but the matured one counts until the new one matures
        vm.prank(keeper);
        vault.reportPosition(decisionId, 0);
        assertTrue(vault.closeVoteAllowed(decisionId));
        vm.warp(_now() + REPORT_WINDOW - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ReportPending.selector, decisionId, _now() + 1));
        vault.reportPosition(decisionId, capital * 2);

        // the guardian's veto is the only way to file a new one early
        vm.prank(guardian);
        vault.revokeReport(decisionId);
        vm.prank(keeper);
        vault.reportPosition(decisionId, capital * 2);
        assertTrue(vault.closeVoteAllowed(decisionId), "falls back to the matured report meanwhile");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // L2 — fake-close cycling is throttled
    // ---------------------------------------------------------------------------------------------------------------

    /// PoC: with a stolen key, "close with nothing back → new decision → execute" parked ≈ 89% of the USDG at the
    /// SpokePool after 10 decisions, as fast as governance minted them. Now (1) a position must be one challenge
    /// window old before the keeper may close it on its own, and (2) a close that returned less than its capital
    /// blocks the next order for one more window: every fake close is public for ≥ 12 h before more USDG leaves.
    function test_regression_fakeCloseCycleThrottled() public {
        _closeWithReturn(0); // pretend nothing came back
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 amt = vault.maxOrderAmount();
        uint256 cooldownEnd = vault.nextExecuteAt();
        assertEq(cooldownEnd, _now() + REPORT_WINDOW);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ExecuteCooldown.selector, cooldownEnd));
        vault.executeDecision(amt, amt, uint32(_now()), uint32(_now()) + FILL_WINDOW);

        vm.warp(cooldownEnd);
        uint256 openedAt = _now();
        _execute(amt);
        // fresh position, no governance reason to close: the keeper must wait one window
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionTooYoung.selector, id, openedAt + REPORT_WINDOW));
        vault.reportClosed(id);
        vm.warp(openedAt + REPORT_WINDOW - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionTooYoung.selector, id, openedAt + REPORT_WINDOW));
        vault.reportClosed(id);
        vm.warp(openedAt + REPORT_WINDOW);
        vm.prank(keeper);
        vault.reportClosed(id);
        vm.warp(_now() + REPORT_WINDOW);
        vault.finalizeClose(id);
        assertEq(vault.nextExecuteAt(), _now() + REPORT_WINDOW);
        // one fake cycle now costs ≥ 3 windows (age + challenge + cooldown) of public, guardian-revocable state
        assertGe(_now() + REPORT_WINDOW - openedAt, 3 * REPORT_WINDOW);
    }

    /// The minimum age never blocks a governance-driven close (none of its causes can be produced by the keeper),
    /// and a close that brought the capital back needs no cooldown.
    function test_regression_governanceDrivenCloseNotBlocked() public {
        _closeWithReturn(capital); // flat: no cooldown
        assertEq(vault.nextExecuteAt(), 0);
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 amt = vault.maxOrderAmount();
        _execute(amt);

        // superseded by a newer decision → closable at once
        gov.nextDecision(ETH_ASSET, IWarchestDecisionSource.Side.Short);
        assertTrue(vault.mustClose());
        vm.prank(keeper);
        vault.reportClosed(id);
        usdg.mint(address(vault), amt + 100e6);
        vm.warp(_now() + REPORT_WINDOW);
        vault.finalizeClose(id);
        assertEq(vault.nextExecuteAt(), 0, "capital came back: no cooldown");
        uint256 id2 = vault.lastExecutedDecisionId() + 1;
        _execute(1_000e6); // the newer decision executes immediately
        assertEq(vault.position().decisionId, id2);

        // close vote → closable at once
        gov.setCloseRequested(id2, true);
        vm.prank(keeper);
        vault.reportClosed(id2);
        usdg.mint(address(vault), 1_000e6);
        vm.warp(_now() + REPORT_WINDOW);
        vault.finalizeClose(id2);

        // pause → closable at once (even while paused)
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 id3 = vault.lastExecutedDecisionId() + 1;
        _execute(1_000e6);
        vm.prank(guardian);
        vault.setPaused(true);
        vm.prank(keeper);
        vault.reportClosed(id3);
        assertEq(vault.position().closeReportedAt, _now());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // L3 — mainnet defaults refuse any other chain
    // ---------------------------------------------------------------------------------------------------------------

    function test_regression_deploySystemRefusesWrongChain() public {
        DeploySystem script = new DeploySystem();
        assertEq(block.chainid, 31337);
        vm.expectRevert(abi.encodeWithSelector(DeploySystem.WrongChain.selector, 31337, 4663));
        script.defaultSystemConfig(guardian, updater, keeper, hlAccount, true);
        vm.chainId(4663);
        DeploySystem.SystemConfig memory sys = script.defaultSystemConfig(guardian, updater, keeper, hlAccount, true);
        assertEq(address(sys.venue.pool), 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca);
        assertEq(sys.bridge.recipient, hlAccount);
    }
}
